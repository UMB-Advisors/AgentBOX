#!/usr/bin/env bash
# hermesBOX — Phase 3 acceptance verification. Run on the box.
# Verifies the fallback provider chain is wired behind the primary brain.
# Spec: docs/PRD-ADDENDUM-001-cloud-inference.md (Phase 3) · Linear UMB-382
#
# Two tiers of checks:
#   STRUCTURAL (always must pass): chain is configured, ordered, providers authed.
#   FUNDED (gated/INFO): a real fallthrough only works once keys are funded.
#     OPENROUTER_API_KEY (402 until topped up) / OPENAI_API_KEY (quota until billed).
#     These are reported as INFO, not FAIL, so the phase passes when wired-but-unfunded.
set -uo pipefail
. "${HOME}/.hermesbox_env.sh" 2>/dev/null || true
HH="${HERMES_HOME:-$HOME/.hermes}"

# Expected primary + ordered fallbacks (must match 30-fallback.sh)
EXP_PRIMARY_PROVIDER="openai-codex"
EXP_FB1="openrouter:openai/gpt-4o"
EXP_FB2="openai-api:gpt-4o"

pass=0; fail=0
ok(){ echo "  PASS  $*"; pass=$((pass+1)); }
no(){ echo "  FAIL  $*"; fail=$((fail+1)); }
info(){ echo "  INFO  $*"; }

echo "=== hermesBOX Phase 3 acceptance (fallback routing) ==="

# Pull the effective chain + primary straight from the agent's own loader.
read_state() {
  "${HERMES_HOME:-$HOME/.hermes}/hermes-agent/venv/bin/python" - <<'PY' 2>/dev/null
try:
    from hermes_cli.config import load_config
    from hermes_cli.fallback_config import get_fallback_chain
except Exception as e:
    print("IMPORT_ERR")
    raise SystemExit(0)
cfg = load_config()
m = cfg.get("model") or {}
prov = (m.get("provider") or "").strip() if isinstance(m, dict) else ""
mod = (m.get("default") or m.get("model") or "").strip() if isinstance(m, dict) else ""
print(f"PRIMARY\t{prov}\t{mod}")
for e in get_fallback_chain(cfg):
    print(f"FB\t{e.get('provider','')}\t{e.get('model','')}")
PY
}

STATE="$(read_state)"
if echo "$STATE" | grep -q "IMPORT_ERR" || [ -z "$STATE" ]; then
  no "could not read hermes config via hermes_cli (env/venv not active?)"
  echo "PHASE3_VERIFY_INCOMPLETE"; exit 1
fi

# 1) Primary provider unchanged (still openai-codex)
prim_provider=$(echo "$STATE" | awk -F'\t' '$1=="PRIMARY"{print $2}')
prim_model=$(echo "$STATE" | awk -F'\t' '$1=="PRIMARY"{print $3}')
if [ "$prim_provider" = "$EXP_PRIMARY_PROVIDER" ]; then
  ok "primary provider intact ($prim_provider / ${prim_model:-?})"
else
  no "primary provider changed: got '$prim_provider', want '$EXP_PRIMARY_PROVIDER'"
fi

# 2) Fallback chain non-empty
chain=$(echo "$STATE" | awk -F'\t' '$1=="FB"{print $2":"$3}')
n=$(echo "$chain" | grep -c . || true)
if [ "$n" -ge 1 ]; then ok "fallback chain configured ($n entries)"; else no "fallback chain is empty"; fi

# 3) Exact ordered chain matches expected (openrouter first, then openai-api)
got_order=$(echo "$chain" | paste -sd'>' -)
want_order="${EXP_FB1}>${EXP_FB2}"
if [ "$got_order" = "$want_order" ]; then
  ok "chain order correct ($got_order)"
else
  no "chain order mismatch: got '$got_order', want '$want_order'"
fi

# 4) Primary is not duplicated inside the fallback chain
if echo "$chain" | grep -qi "^${EXP_PRIMARY_PROVIDER}:"; then
  no "primary provider appears in fallback chain (a provider cannot fall back to itself)"
else
  ok "primary not present in fallback chain"
fi

# 5) Every fallback provider is authenticated
auth="$(hermes auth list 2>/dev/null || true)"
for entry in $chain; do
  p="${entry%%:*}"
  if echo "$auth" | grep -qE "^${p} \("; then
    ok "fallback provider '$p' is authenticated"
  else
    no "fallback provider '$p' has no credentials (hermes auth add $p)"
  fi
done

# 6) hermes fallback list renders the chain (CLI agrees with config)
if hermes fallback list 2>/dev/null | grep -qiE "Fallback chain \([0-9]+ entr"; then
  ok "hermes fallback list reports a populated chain"
else
  no "hermes fallback list does not show a populated chain"
fi

# --- FUNDED tier (INFO only; gates real fallthrough, not phase acceptance) ---
echo "--- funding status (informational; chain is inert until funded) ---"
ork=$(grep -E '^OPENROUTER_API_KEY=' "$HH/.env" 2>/dev/null | cut -d= -f2-)
oai=$(grep -E '^OPENAI_API_KEY=' "$HH/.env" 2>/dev/null | cut -d= -f2-)
[ -n "$ork" ] && info "OPENROUTER_API_KEY present (verify balance > 0 at openrouter.ai/credits)" \
              || info "OPENROUTER_API_KEY EMPTY in .env — OpenRouter fallback will not engage"
[ -n "$oai" ] && info "OPENAI_API_KEY present (verify billing enabled; sk- key needs paid quota)" \
              || info "OPENAI_API_KEY EMPTY in .env — direct OpenAI fallback will not engage"

# Optional live probe of OpenRouter balance if a key is present (read-only GET).
if [ -n "${ork:-}" ]; then
  code=$(curl -s -o /dev/null -w '%{http_code}' \
    -H "Authorization: Bearer $ork" https://openrouter.ai/api/v1/credits 2>/dev/null || echo "000")
  case "$code" in
    200) info "OpenRouter /credits -> 200 (key valid; check returned balance)";;
    401) info "OpenRouter /credits -> 401 (key invalid/expired)";;
    402) info "OpenRouter /credits -> 402 (insufficient balance — TOP UP to enable fallthrough)";;
    *)   info "OpenRouter /credits -> HTTP $code";;
  esac
fi

echo "=== result: ${pass} pass / ${fail} fail ==="
echo "NOTE: passing here means the chain is correctly WIRED. A real fallthrough"
echo "      requires funded keys (human-in-the-loop) — see INFO lines above."
[ "$fail" -eq 0 ] && echo "PHASE3_VERIFY_OK" || echo "PHASE3_VERIFY_INCOMPLETE"
