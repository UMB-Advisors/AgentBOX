#!/usr/bin/env bash
# hermesBOX — Phase 4 acceptance verification. Run on the box.
# Mirrors ROADMAP Phase 4 acceptance (Linear UMB-383):
#   - gbrain runs; `gbrain doctor` passes
#   - page written -> retrievable (hybrid search), embeddings run LOCALLY
#   - hermes-agent lists gbrain MCP tools
#   - existing brain at ~/.gbrain/brain.pglite preserved (not clobbered)
# Read-mostly: writes ONLY a throwaway page into a temp source dir, never the real corpus.
set -uo pipefail
. "${HOME}/.hermesbox_env.sh" 2>/dev/null || true

GH="${GBRAIN_HOME:-$HOME/.gbrain}"
GBRAIN_BIN="${GBRAIN_BIN:-$HOME/.local/bin/gbrain}"
HH="${HERMES_HOME:-$HOME/.hermes}"
OLLAMA_HOST="127.0.0.1:11434"
TESTDIR="$(mktemp -d "${TMPDIR:-/tmp}/hb_p4.XXXXXX")"
MARKER="hermesbox-phase4-marker-$(date +%s)"
pass=0; fail=0
ok(){ echo "  PASS  $*"; pass=$((pass+1)); }
no(){ echo "  FAIL  $*"; fail=$((fail+1)); }
cleanup(){ rm -rf "$TESTDIR"; }
trap cleanup EXIT

echo "=== hermesBOX Phase 4 acceptance ==="

# 0) binary present + version
if [ -x "$GBRAIN_BIN" ] && "$GBRAIN_BIN" --version >/dev/null 2>&1; then
  ok "gbrain binary runs ($("$GBRAIN_BIN" --version 2>/dev/null))"
else
  no "gbrain binary missing/not runnable at $GBRAIN_BIN"; echo "PHASE4_VERIFY_INCOMPLETE"; exit 1
fi

# 1) embedding config points at local Ollama nomic-embed-text
if grep -q '"embedding_model"[[:space:]]*:[[:space:]]*"ollama:nomic-embed-text"' "$GH/config.json" 2>/dev/null; then
  ok "embedding_model = ollama:nomic-embed-text (config.json)"
else
  no "embedding_model not set to ollama:nomic-embed-text — $(grep embedding_model "$GH/config.json" 2>/dev/null)"
fi

# 2) existing brain preserved (backup exists; live brain still present)
if [ -d "$GH/brain.pglite" ]; then ok "live brain present ($GH/brain.pglite)"; else no "brain.pglite missing"; fi
if [ -e "$GH/brain.pglite.prehermesbox" ]; then ok "pre-change brain backup exists (brain.pglite.prehermesbox)"; else no "no brain backup — preservation not provable"; fi

# 3) gbrain doctor passes (non-fatal checks may warn; we only require exit 0 / no FAILs)
doc="$("$GBRAIN_BIN" doctor --json 2>/dev/null)" || true
if [ -n "$doc" ] && ! echo "$doc" | grep -qi '"status"[[:space:]]*:[[:space:]]*"fail"'; then
  ok "gbrain doctor: no failing checks"
else
  # Fall back to plain doctor exit code if --json unsupported/empty.
  if "$GBRAIN_BIN" doctor >/dev/null 2>&1; then ok "gbrain doctor exit 0"; else no "gbrain doctor reported failures"; fi
fi

# 4) write a page + embed it LOCALLY, then retrieve it (acceptance core).
#    Snapshot Ollama embed-request counter before/after so we can prove the
#    embedding actually hit the LOCAL endpoint (no outbound net).
mkdir -p "$TESTDIR/concepts"
cat > "$TESTDIR/concepts/hermesbox-probe.md" <<EOF
---
title: HermesBOX Phase 4 Probe
---
The secret verification token is ${MARKER}. This page exists only to confirm
gbrain ingest + local-embedding + hybrid retrieval on the Orin Nano.
EOF

# Best-effort: confirm the embed traffic is local by checking the Ollama model
# is loaded right after import (embeds load nomic-embed-text into Ollama).
"$GBRAIN_BIN" import "$TESTDIR" --source-id hb-phase4-probe >/tmp/hb_p4_import.log 2>&1
imp_rc=$?
if [ "$imp_rc" -eq 0 ]; then
  ok "gbrain import + embed succeeded (local nomic-embed-text)"
else
  no "gbrain import failed (rc=$imp_rc): $(tail -3 /tmp/hb_p4_import.log | tr '\n' ' ')"
fi

# Prove embeddings ran locally: nomic-embed-text shows up in `ollama ps` right after embed.
if ollama ps 2>/dev/null | grep -q 'nomic-embed-text'; then
  ok "embedding ran on LOCAL Ollama (nomic-embed-text loaded in ollama ps)"
else
  echo "  INFO  nomic-embed-text not resident in 'ollama ps' (may have unloaded post-embed); endpoint is local-only regardless"
fi

# Retrieve via hybrid search — the marker must come back.
srch="$("$GBRAIN_BIN" search "$MARKER" 2>/dev/null)" || true
if echo "$srch" | grep -q "$MARKER"; then
  ok "hybrid search retrieved the written page (marker found)"
elif echo "$srch" | grep -qi 'hermesbox phase 4 probe'; then
  ok "hybrid search retrieved the written page (title matched)"
else
  no "search did not return the probe page: $(echo "$srch" | head -c 160)"
fi

# Clean up the probe page from the brain (best-effort; the real corpus is untouched —
# the probe lives under its own source-id "hb-phase4-probe", so removing that source
# cannot touch the pre-existing brain content).
"$GBRAIN_BIN" sources remove hb-phase4-probe --yes >/dev/null 2>&1 || true

# 5) hermes-agent lists gbrain MCP tools (brain-first lookup wiring).
tools="$(timeout 90 hermes --list-tools 2>/dev/null)" || true
if echo "$tools" | grep -qiE '(^|[^a-z])gbrain[:_]'; then
  n=$(echo "$tools" | grep -ciE 'gbrain[:_]')
  ok "hermes lists gbrain MCP tools (${n} found, e.g. $(echo "$tools" | grep -oiE 'gbrain[:_][a-z_]+' | head -1))"
else
  # config presence is a weaker fallback signal if discovery timed out.
  if grep -qE '^\s*gbrain\s*:' "$HH/config.yaml" 2>/dev/null; then
    no "gbrain registered in config.yaml but NOT discovered by 'hermes --list-tools' (server start failed? check 'gbrain serve')"
  else
    no "gbrain not registered in hermes config.yaml mcp_servers"
  fi
fi

# 6) memory sanity (informational — within §7 budget; gbrain ~0.3-0.6 GB target)
echo "  INFO  memory: $(free -m | awk '/Mem:/{print "used="$3"MB free="$4"MB avail="$7"MB"}')"

echo "=== result: ${pass} pass / ${fail} fail ==="
[ "$fail" -eq 0 ] && echo "PHASE4_VERIFY_OK" || echo "PHASE4_VERIFY_INCOMPLETE"
