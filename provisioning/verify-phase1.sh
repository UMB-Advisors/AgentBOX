#!/usr/bin/env bash
# hermesBOX — Phase 1 acceptance verification. Run on the box.
# Mirrors ROADMAP Phase 1 acceptance (Linear UMB-380).
set -uo pipefail
. "${HOME}/.hermesbox_env.sh" 2>/dev/null || true
API="127.0.0.1:11434"
MODEL="hermes3:3b"
pass=0; fail=0
ok(){ echo "  PASS  $*"; pass=$((pass+1)); }
no(){ echo "  FAIL  $*"; fail=$((fail+1)); }

echo "=== hermesBOX Phase 1 acceptance ==="

# 1) API up
if curl -fsS "$API/api/version" >/dev/null 2>&1; then
  ok "ollama API up ($(curl -fsS $API/api/version))"
else
  no "ollama API not responding"; echo "PHASE1_VERIFY_INCOMPLETE"; exit 1
fi

# memory baseline with model unloaded
ollama stop "$MODEL" >/dev/null 2>&1 || true
sleep 2
base_used=$(free -m | awk '/Mem:/{print $3}')

# 2) OpenAI-compatible chat completion returns non-empty content
resp=$(curl -fsS "$API/v1/chat/completions" -H 'Content-Type: application/json' \
  -d "{\"model\":\"$MODEL\",\"messages\":[{\"role\":\"user\",\"content\":\"Say hello in one short sentence.\"}],\"stream\":false}")
content=$(echo "$resp" | python3 -c 'import sys,json
try:
  d=json.load(sys.stdin); print(d["choices"][0]["message"]["content"].strip())
except Exception as e: print("")' 2>/dev/null)
if [ -n "$content" ]; then ok "/v1/chat/completions -> \"${content:0:70}\""; else no "/v1/chat/completions returned no content: ${resp:0:160}"; fi

# 3) GPU during generation (tegrastats GR3D) + 4) tokens/sec & first-token latency
: > /tmp/hb_tg.txt
( timeout 12 tegrastats --interval 500 >/tmp/hb_tg.txt 2>/dev/null ) &
tgpid=$!
gen=$(curl -fsS "$API/api/generate" -H 'Content-Type: application/json' \
  -d "{\"model\":\"$MODEL\",\"prompt\":\"Write three sentences about edge AI on small devices.\",\"stream\":false}")
sleep 1; kill "$tgpid" 2>/dev/null || true; wait "$tgpid" 2>/dev/null || true

maxgpu=$(grep -o 'GR3D_FREQ [0-9]\+%' /tmp/hb_tg.txt | grep -o '[0-9]\+' | sort -rn | head -1)
maxgpu=${maxgpu:-0}
if [ "$maxgpu" -gt 0 ] 2>/dev/null; then ok "GPU engaged during inference (peak GR3D ${maxgpu}%)"; else no "no GPU load seen in tegrastats (CPU-only?)"; fi

read tps ftl load_ms < <(echo "$gen" | python3 -c 'import sys,json
d=json.load(sys.stdin)
ec=d.get("eval_count",0); ed=d.get("eval_duration",1) or 1
ped=d.get("prompt_eval_duration",0) or 0; ld=d.get("load_duration",0) or 0
print(round(ec/(ed/1e9),1), round(ped/1e9,2), round(ld/1e9,2))' 2>/dev/null)
tps=${tps:-0}; ftl=${ftl:-0}; load_ms=${load_ms:-0}
echo "  INFO  throughput=${tps} tok/s · prompt-eval(first-token proxy)=${ftl}s · model-load=${load_ms}s"
awk "BEGIN{exit !(${ftl} < 3.0)}" && ok "first-token proxy < 3s (${ftl}s)" || no "first-token proxy >= 3s (${ftl}s)"
awk "BEGIN{exit !(${tps} > 0)}" && ok "throughput recorded (${tps} tok/s)" || no "no throughput recorded"

# model-loaded memory delta
loaded_used=$(free -m | awk '/Mem:/{print $3}')
delta=$((loaded_used - base_used))
echo "  INFO  memory: baseline=${base_used}MB loaded=${loaded_used}MB delta=${delta}MB (budget ~2500-3000MB for model)"
awk "BEGIN{exit !(${delta} < 3500)}" && ok "model memory delta within budget (${delta}MB)" || no "model memory delta over budget (${delta}MB)"

echo "=== result: ${pass} pass / ${fail} fail ==="
[ "$fail" -eq 0 ] && echo "PHASE1_VERIFY_OK" || echo "PHASE1_VERIFY_INCOMPLETE"
