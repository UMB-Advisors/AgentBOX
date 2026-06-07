# Runbook — llama.cpp Migration on T2 (STAQPRO-338 / DR-25)

> **Version:** v0.2.0
> **Created:** 2026-05-14 (revision of v0.1.0)
> **Last validated:** Partial — M1 cutover executed 2026-05-14 01:47 PDT, reverted to Ollama at T+7h. See **Appendix A**.
> **Target appliance:** `mailbox2` (M2, `192.168.50.11`, customer #2 — Staqs) — the M1 backport informs every change in this version
> **Estimated session length:** 90–120 min (build/pull + cutover + soak observation)
> **Decision record:** DR-25 in `dashboard/.planning/spec/addendum-t2-build-validation-v0_2-2026-05-13.md`
> **Implementation plan:** `docs/plan-staqpro-338-llamacpp-migration-v0_1-2026-05-13.md`

---

## What changed from v0.1.0

| # | Change | Why |
|---|---|---|
| 1 | **§0 added** — explicit dashboard `environment:` block requirement at the top of the doc | M1 surfaced this as an undocumented runbook gap: `mailbox-dashboard` does NOT use `env_file:`, so editing `.env` alone cannot reach the container. Without the compose-level forwarding block, the cutover flip silently no-ops. This is the **M2 footgun**. |
| 2 | **§1f added** — orphan-container pre-flight check | M1's DR-25 dry run misdiagnosed Jetson as too small to host llama.cpp; root cause was a 3.86 GiB orphan container. Adding the explicit pre-flight prevents the same misdiagnosis. See memory `[[jetson-memory-diagnostics-orphan-containers]]`. |
| 3 | **§5 yaml updated** — `--flash-attn --cache-type-k q8_0 --cache-type-v q8_0` flags promoted from "consider these" to default | Empirically validated on M1: with these flags Q4_K_M Qwen3-4B sits at ~3.0 GiB GPU; without them the same model + 4096 ctx ran out of unified RAM. |
| 4 | **§8.1 + §8.2 + §9 + §10 queries fixed** — `classification_log.category` + `model_version` (was `classification` + `model`) | v0.1.0 had wrong column names. Real schema: `category`, `confidence`, `model_version`, `latency_ms`, `raw_output`, `json_parse_ok`, `think_stripped`. |
| 5 | **§8.2 SM-68 ceiling adjusted** — combined memory acceptance now ≤ 7.0 GiB (was implicit 4.0 GiB GPU-only) | M1 empirical: ~6.9 GiB combined system + 1.1 GiB headroom on 8 GB unified RAM. The 4 GiB GPU-only ceiling was misleading because Jetson unified-memory makes GPU/CPU split irrelevant. Track unified-RAM-pressure, not GPU-line-item. |
| 6 | **§11 cross-link to STAQPRO-361 added** — cosmetic `gpt-3.5-turbo` envelope leak | Doesn't block cutover but pollutes `drafts.model` telemetry; track as follow-up. |
| 7 | **Appendix A added** — M1 historical execution timeline | Capture the actual outcome of the 2026-05-14 cutover so M2 backport operators inherit institutional memory. |
| 8 | **§0.5 added** — second footgun: proxy URL `/dashboard/` basePath + workflow patch | Post-revert forensics (see `docs/dr25-revert-root-cause-2026-05-14.md`) found two un-applied prereqs that the v0.1 envelope-diff gate failed to catch. Compose changes from §0 are necessary but not sufficient. |

---

## §0. M2 footgun — read first

The single most load-bearing change between v0.1.0 and v0.2.0:

**`mailbox-dashboard` does NOT use `env_file:` in `docker-compose.yml`.** It declares its environment surface field-by-field under `environment:`. New variables added to `.env` are not implicitly forwarded — they must be named explicitly in the dashboard service's `environment:` block.

If you set `LOCAL_INFERENCE_RUNTIME=llama-cpp` in `.env` and then `docker compose up -d mailbox-dashboard` without first adding the compose forwarding block, the dashboard container starts with `LOCAL_INFERENCE_RUNTIME` unset and the router defaults to Ollama. **The flip silently no-ops.** Drafts continue to route through Ollama. Classification continues to route through Ollama. The only signal of failure is that the llama-cpp container's `/v1/chat/completions` access log stays empty.

The compose change is captured in the STAQPRO-360 PR (branch `worktree-staqpro-360`). Before doing the on-device cutover, verify the dashboard `environment:` block reads:

```yaml
  mailbox-dashboard:
    # ... existing fields ...
    environment:
      # ... existing vars ...
      LOCAL_INFERENCE_RUNTIME: ${LOCAL_INFERENCE_RUNTIME:-ollama}
      LLAMA_CPP_BASE_URL: ${LLAMA_CPP_BASE_URL:-http://llama-cpp:8080}
      LLAMA_CPP_MODEL: ${LLAMA_CPP_MODEL:-qwen3-4b-ctx4k}
```

The `:-ollama` default keeps M2's pre-cutover behavior byte-identical until `.env` is edited, so this block can ship to M2 first and the `.env` flip can come in a later step.

**Verification one-liner after `docker compose up -d mailbox-dashboard`:**

```bash
ssh mailbox2 'docker exec mailbox-dashboard env | grep -E "^(LOCAL_INFERENCE_RUNTIME|LLAMA_CPP_)"'
# Expected three lines: LOCAL_INFERENCE_RUNTIME, LLAMA_CPP_BASE_URL, LLAMA_CPP_MODEL
# If any line is missing: STOP. The compose `environment:` block is incomplete.
```

---

## §0.5. Second footgun — proxy URL `/dashboard/` basePath (post-2026-05-14 revert)

The 2026-05-14 M1 cutover revert (see `docs/dr25-revert-root-cause-2026-05-14.md`) surfaced TWO additional must-fix items that the v0.1 runbook did not call out. **Until both are addressed, the cutover cannot succeed**; the compose changes from §0 are necessary but not sufficient.

### A. Dashboard proxy URL default is missing the `/dashboard/` basePath

`dashboard/lib/drafting/router.ts:45`:

```ts
const DASHBOARD_LLM_PROXY_BASE =
  process.env.DASHBOARD_LLM_PROXY_BASE_URL ?? 'http://mailbox-dashboard:3001/api/internal/llm';
```

The default URL omits the Next.js App Router `basePath: '/dashboard'` configured in `dashboard/next.config.mjs`. Every other internal-route URL in `MailBOX-Classify.json` (lines 203, 284, 502) correctly uses the `/dashboard/` prefix. When `LOCAL_INFERENCE_RUNTIME=llama-cpp`, drafts route to the proxy URL — which returns 404 because of this defect.

**Permanent fix (preferred):** patch the default in source to `'http://mailbox-dashboard:3001/dashboard/api/internal/llm'` and ship it. Single-line change in a sibling PR.

**Operational workaround until the code fix lands:** add the env override to BOTH `.env` AND the dashboard `environment:` block in `docker-compose.yml`:

```yaml
  mailbox-dashboard:
    environment:
      # ... existing vars ...
      DASHBOARD_LLM_PROXY_BASE_URL: ${DASHBOARD_LLM_PROXY_BASE_URL:-http://mailbox-dashboard:3001/dashboard/api/internal/llm}
```

The STAQPRO-360 compose change does NOT currently forward `DASHBOARD_LLM_PROXY_BASE_URL`. If you go the workaround route, you must add it.

### B. n8n MailBOX-Classify workflow "Call Ollama" node URL never patched

`n8n/workflows/MailBOX-Classify.json:264` still has:

```json
"url": "http://ollama:11434/api/generate"
```

This must change to:

```json
"url": "http://mailbox-dashboard:3001/dashboard/api/internal/llm/api/generate"
```

The procedural patch document is `docs/n8n-workflow-patch-staqpro-338.md` (URL corrected in this session). Apply via:

```bash
ssh mailbox2 'cd ~/mailbox && \
  sed -i "s|http://ollama:11434/api/generate|http://mailbox-dashboard:3001/dashboard/api/internal/llm/api/generate|" \
    n8n/workflows/MailBOX-Classify.json && \
  docker exec mailbox-n8n-1 n8n import:workflow --input=/home/node/workflows/MailBOX-Classify.json'

WORKFLOW_ID=$(ssh mailbox2 'docker exec mailbox-postgres-1 psql -U mailbox -d mailbox -tAc \
  "SELECT id FROM workflow_entity WHERE name='\''MailBOX-Classify'\''"')

ssh mailbox2 "docker exec mailbox-n8n-1 n8n update:workflow --active=true --id=$WORKFLOW_ID && \
  cd ~/mailbox && docker compose restart n8n"
```

Then re-run the **post-n8n-upgrade verification one-liner** (project CLAUDE.md → Deployment Target) — all four `MailBOX%` workflows must show `active=t`.

### Hardened §6 envelope-diff gate

The v0.1 §6 gate let the 2026-05-14 cutover proceed with a broken proxy URL because it accepted empty responses as a "no-op pass" instead of failing loudly on 404. Until the v0.1 gate is rewritten:

```bash
# Before §7 cutover, prove the proxy URL works from inside the n8n container
# (NOT from the workstation — production traffic comes from n8n's docker network position).
ssh mailbox2 'docker exec mailbox-n8n-1 wget -qO- --post-data="{\"model\":\"qwen3:4b-ctx4k\",\"prompt\":\"ping\",\"stream\":false}" \
  --header="content-type: application/json" \
  http://mailbox-dashboard:3001/dashboard/api/internal/llm/api/generate' \
  | jq -r '.response | length'
# Expected: a positive integer. If the curl returns empty or 404: STOP.
# The router.ts default URL is wrong (see §0.5.A); apply the workaround before §7.
```

---

## §1. Prerequisites — verify before SSH

```bash
# 1a. Stage 1 dashboard code on master (SDK abstraction merged)
git log origin/master --oneline | head -10
# Look for: "feat(llm): SDK HTTP abstraction (...STAQPRO-338...)" — already merged 2026-05-13

# 1b. The compose changes from STAQPRO-360 are on master (or available as a branch)
git log origin/master --oneline -- docker-compose.yml | head -5
# Look for the STAQPRO-360 commit. If still on a branch, note the branch name for §3.

# 1c. On-appliance repo is clean
ssh mailbox2 'cd ~/mailbox && git status --short && git log --oneline -3'

# 1d. Customer-facing health is green
ssh mailbox2 'cd ~/mailbox && docker compose ps && \
  docker exec mailbox-postgres-1 psql -U mailbox -d mailbox -tAc \
  "SELECT count(*) FROM mailbox.drafts WHERE status='\''pending'\'' AND created_at > NOW() - INTERVAL '\''15 minutes'\'';"'
# All services Up. No backlog of >5 pending drafts in the last 15 min.

# 1e. GGUF source path decision (DR-25 §8.6.q.4 — recommended: HuggingFace)

# 1f. NEW IN v0.2 — orphan-container pre-flight (skip at your peril)
ssh mailbox2 'docker ps -a --format "table {{.Names}}\t{{.Status}}\t{{.Size}}" | head -30'
# Look for:
#   - Exited containers from prior llama-cpp / dev work still holding writable layer space
#   - Two containers with very similar names (orphan from compose rename)
# If you see anything in `Exited` state that's > ~500 MB writable layer or anything
# named like `mailbox-llama-cpp-1` already exists: stop and reconcile before §3.
# The M1 misdiagnosis ("Jetson is too small for llama.cpp on Q4_K_M") was caused
# by a 3.86 GiB orphan container eating unified RAM during the measurement.

ssh mailbox2 'docker system df'
# Healthy: < 60 GB total, < 5 GB reclaimable. If reclaimable > 10 GB,
# run `docker system prune` (interactively) before §3.
```

---

## §2. Capture the baseline before any change

Identical to v0.1.0 §2. Snapshots go to `~/dr25-baseline` on the appliance.

```bash
ssh mailbox2
mkdir -p ~/dr25-baseline && cd ~/dr25-baseline

# Memory baseline
free -h > free-pre.txt
nvidia-smi --query-gpu=memory.used,memory.free,memory.total --format=csv > gpu-pre.txt
docker stats --no-stream --format 'table {{.Name}}\t{{.MemUsage}}\t{{.CPUPerc}}' > docker-stats-pre.txt

# Generation rate baseline (Ollama side, for side-by-side comparison)
docker exec mailbox-ollama-1 ollama run qwen3:4b-ctx4k --verbose \
  "Reply to a customer asking about order status." 2>&1 | tail -20 > ollama-tokrate-pre.txt

# Cycle latency baseline (last 24h of MailBOX-Classify executions)
docker exec mailbox-postgres-1 psql -U mailbox -d mailbox -tAc \
  "SELECT percentile_cont(0.95) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM (\"finishedAt\"::timestamp - \"startedAt\"::timestamp))) AS p95_seconds
   FROM execution_entity
   WHERE \"workflowId\" = (SELECT id FROM workflow_entity WHERE name='MailBOX-Classify')
     AND \"finishedAt\" > NOW() - INTERVAL '24 hours';" \
  > classify-p95-pre.txt

cat free-pre.txt gpu-pre.txt ollama-tokrate-pre.txt classify-p95-pre.txt
```

**Decision point:** If any baseline reads anomalous (classify p95 > 9 s already), DO NOT proceed. File a regression issue first.

---

## §3. Build (or pull) llama.cpp ARM64 + CUDA

### 3.1 Preferred path — pull a pre-built image

```bash
ssh mailbox2
docker manifest inspect ghcr.io/ggml-org/llama.cpp:server-cuda 2>&1 | head -40
# Look for: "architecture": "arm64" and CUDA version matching JetPack 6.2.
# If present:
docker pull ghcr.io/ggml-org/llama.cpp:server-cuda
docker tag ghcr.io/ggml-org/llama.cpp:server-cuda local/llama-cpp:cuda-jetson
```

If the manifest lacks ARM64 + CUDA 12.6 (or fails to start with the expected GPU init log), use the **dustynv** lineage instead — it's what M1 actually ran:

```bash
docker pull dustynv/llama_cpp:r36.4.0
docker tag dustynv/llama_cpp:r36.4.0 local/llama-cpp:cuda-jetson
```

**Note (v0.2):** the dustynv image has an empty entrypoint and a bash cmd. The compose `entrypoint: ["/usr/local/bin/llama-server"]` override in §5 is what makes `command:` provide ONLY the server args. If you skip the override, the args fall through to `bash` and the container errors out with `bash: --model: command not found`.

### 3.2 Fallback — build from source on-device

Same as v0.1.0; OOM-during-link recovery (stop n8n + qdrant, rebuild, restart) still applies.

### 3.3 Verify the image

```bash
docker run --rm --runtime nvidia local/llama-cpp:cuda-jetson --version
docker run --rm --runtime nvidia local/llama-cpp:cuda-jetson \
  bash -c 'nvidia-smi -L' 2>&1 | head -3
# Expected: "GPU 0: Orin (UUID: ...)"
```

---

## §4. Source the GGUF

Identical to v0.1.0 §4. End state: `~/mailbox/llama-cpp-models/qwen3-4b-ctx4k.gguf` exists, ~2.4 GiB.

---

## §5. Stand up the llama-cpp service alongside Ollama

**v0.2 change:** the compose service block now includes the empirically-validated flag set. These are the same flags the STAQPRO-360 PR captures.

Add to `~/mailbox/docker-compose.yml` (or `git pull` if the PR has merged):

```yaml
  llama-cpp:
    image: local/llama-cpp:cuda-jetson
    runtime: nvidia
    container_name: mailbox-llama-cpp-1
    # STAQPRO-338 / DR-25: dustynv/llama_cpp:r36.4.0 retagged.
    # Image has empty entrypoint + bash cmd; override entrypoint to the
    # server binary so docker-compose `command:` provides only args.
    entrypoint: ["/usr/local/bin/llama-server"]
    command:
      - "--model"
      - "/models/qwen3-4b-ctx4k.gguf"
      - "--ctx-size"
      - "4096"
      - "--flash-attn"
      - "--cache-type-k"
      - "q8_0"
      - "--cache-type-v"
      - "q8_0"
      - "--n-gpu-layers"
      - "99"
      - "--no-mmap"
      - "--slots"
      - "--host"
      - "0.0.0.0"
      - "--port"
      - "8080"
    environment:
      LLAMA_LOG_LEVEL: "info"
    volumes:
      - ./llama-cpp-models:/models:ro
    # No ports: block — internal docker network only, matches M2's tighter
    # binding model. Workstation access is via tailnet+ssh tunnel.
    restart: unless-stopped
    depends_on: []
```

Why each non-obvious flag matters:

- `--flash-attn` — keeps attention compute fused; lower peak memory during prefill.
- `--cache-type-k q8_0 --cache-type-v q8_0` — quantizes KV cache to q8_0 (Ollama's default is fp16). At 4096 ctx this shrinks the KV slab roughly 2× and is the single change that brings Q4_K_M Qwen3-4B under 3.0 GiB GPU.
- `--n-gpu-layers 99` — offload everything possible to GPU (overshoot is safe; llama.cpp clamps to model layer count).
- `--no-mmap` — Jetson unified RAM is faster than memory-mapped page faults; `--no-mmap` forces full load on startup.
- `--slots` — enables the slot-based concurrent-request handling that the dashboard expects.

Bring it up + sanity-check:

```bash
cd ~/mailbox
docker compose up -d llama-cpp
docker logs -f mailbox-llama-cpp-1
# Expected sequence:
#   load_model: loading model '/models/qwen3-4b-ctx4k.gguf' ...
#   ggml_cuda_init: found 1 CUDA devices: Orin (sm_87) ...
#   llama_new_context_with_model: n_ctx = 4096 ...
#   main: server is listening on http://0.0.0.0:8080
# Cold load: 10–25 s.

ssh mailbox2 'docker exec mailbox-llama-cpp-1 curl -s http://localhost:8080/health'
# Expected: {"status":"ok"}

nvidia-smi --query-gpu=memory.used --format=csv
# Expected (M1-measured): ~3.0 GiB with llama-cpp alone, ~6.0–6.8 GiB with Ollama also up.
# If > 7.0 GiB combined: investigate before §6.
```

---

## §6. Pre-cutover envelope diff — 20-sample classify comparison

Identical to v0.1.0 §6. Goal: prove the dashboard's llamacpp-client envelope translation produces the same field set Ollama emits. If the field-set diff is non-empty, fix `dashboard/lib/llm/llamacpp-client.ts` before proceeding.

---

## §7. Cutover — flip `LOCAL_INFERENCE_RUNTIME`

```bash
ssh mailbox2
cd ~/mailbox

# 7a. Snapshot the current dashboard env (rollback target)
cp .env .env.bak-pre-dr25-$(date +%Y%m%d-%H%M%S)

# 7b. Flip the env var (or add it if absent)
if grep -q '^LOCAL_INFERENCE_RUNTIME=' .env; then
  sed -i 's|^LOCAL_INFERENCE_RUNTIME=.*|LOCAL_INFERENCE_RUNTIME=llama-cpp|' .env
else
  echo 'LOCAL_INFERENCE_RUNTIME=llama-cpp' >> .env
  echo 'LLAMA_CPP_BASE_URL=http://llama-cpp:8080' >> .env
  echo 'LLAMA_CPP_MODEL=qwen3-4b-ctx4k' >> .env
fi
grep -E '^(LOCAL_INFERENCE_RUNTIME|LLAMA_CPP_)' .env

# 7c. Recreate dashboard (not just restart — env must be re-baked into the container)
docker compose up -d mailbox-dashboard

# 7d. Confirm the dashboard re-read the env (the §0 verification one-liner)
docker exec mailbox-dashboard sh -c 'echo "runtime=$LOCAL_INFERENCE_RUNTIME url=$LLAMA_CPP_BASE_URL model=$LLAMA_CPP_MODEL"'
# Expected: runtime=llama-cpp url=http://llama-cpp:8080 model=qwen3-4b-ctx4k
```

**Dark window:** ~30–60 s during the dashboard recreate (Next.js cold start). The next 5-min n8n cycle (worst case) drops one cycle, recovered by message-id dedup on the cycle after.

---

## §8. Observe — two cycles + 24-hour soak

### 8.1 Immediate (next 15 min)

```bash
# n8n executions green
ssh mailbox2 'docker exec mailbox-postgres-1 psql -U mailbox -d mailbox -tAc \
  "SELECT id, status, mode, EXTRACT(EPOCH FROM (\"finishedAt\"::timestamp - \"startedAt\"::timestamp)) AS dur_s
   FROM execution_entity
   WHERE \"workflowId\" IN (SELECT id FROM workflow_entity WHERE name LIKE '\''MailBOX%'\'')
   ORDER BY \"startedAt\" DESC LIMIT 10;"'

# Fresh classify rows arriving (v0.2 — schema fix: category + model_version)
ssh mailbox2 'docker exec mailbox-postgres-1 psql -U mailbox -d mailbox -tAc \
  "SELECT created_at, category, confidence, model_version
   FROM mailbox.classification_log ORDER BY created_at DESC LIMIT 5;"'
# v0.2 NOTE: `model_version` should now read `qwen3-4b-ctx4k` (no `:` prefix —
# the llama.cpp name convention differs from Ollama's `qwen3:4b-ctx4k` tag style).
# This is the smoking-gun indicator the cutover took effect.
```

### 8.2 24-hour soak — §3.5.5 SM-66 through SM-70

Schedule at T+24h after the cutover:

```bash
cd ~/dr25-baseline

# SM-66: Generation rate
docker exec mailbox-llama-cpp-1 curl -s http://localhost:8080/v1/chat/completions \
  -H 'content-type: application/json' \
  -d '{"model":"qwen3-4b-ctx4k","messages":[{"role":"user","content":"Reply to a customer asking about order status."}],"stream":false}' \
  | jq '.usage, .timings'
# Compare tokens/s vs `ollama-tokrate-pre.txt`. M1 measured ~17 t/s. Acceptance: ≥ 16 t/s.

# SM-67: Cycle latency p95 over the past 24h
docker exec mailbox-postgres-1 psql -U mailbox -d mailbox -tAc \
  "SELECT percentile_cont(0.95) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM (\"finishedAt\"::timestamp - \"startedAt\"::timestamp))) AS p95_seconds
   FROM execution_entity
   WHERE \"workflowId\" = (SELECT id FROM workflow_entity WHERE name='MailBOX-Classify')
     AND \"finishedAt\" > NOW() - INTERVAL '24 hours';"
# Acceptance: ≤ 9 s

# SM-68: Memory (v0.2 — track combined unified-RAM pressure, not GPU-line-item)
free -h
nvidia-smi --query-gpu=memory.used --format=csv
cat /proc/$(pgrep -f 'llama-server')/status | grep VmRSS
# Acceptance (v0.2-revised): combined system unified RAM ≤ 7.0 GiB
# (M1 empirical: ~6.9 GiB used with everything running, ~1.1 GiB headroom on 8 GB.)
# The pre-v0.2 4.0 GiB GPU-only ceiling was misleading on Jetson because unified
# memory means GPU/CPU split is fungible — measure the whole envelope, not the line item.

# SM-69: OOM-killer events
docker logs mailbox-llama-cpp-1 2>&1 | grep -iE 'killed|oom' || echo "no OOM events"
dmesg | grep -iE 'out of memory|oom-killer' || echo "no kernel OOM events"
# Acceptance: 0 events

# SM-70: Cycle success rate (v0.2 — schema fix: model_version, not model)
docker exec mailbox-postgres-1 psql -U mailbox -d mailbox -tAc \
  "SELECT
     (SELECT count(*) FROM mailbox.classification_log
      WHERE created_at > NOW() - INTERVAL '24 hours' AND model_version = 'qwen3-4b-ctx4k')::float /
     NULLIF((SELECT count(*) FROM execution_entity
             WHERE \"workflowId\" = (SELECT id FROM workflow_entity WHERE name='MailBOX-Classify')
               AND \"finishedAt\" > NOW() - INTERVAL '24 hours'), 0)
     AS success_ratio;"
# Acceptance: ≥ 0.99
```

Record all five numbers into addendum v0.2 §3.5.5 (replace "TBD" cells), commit + push.

---

## §9. Decommission Ollama (T+7 days post-green-soak)

Same logic as v0.1.0, with the column-name fix:

```bash
ssh mailbox2 'docker exec mailbox-postgres-1 psql -U mailbox -d mailbox -tAc \
  "SELECT count(*) FROM mailbox.classification_log
   WHERE created_at > NOW() - INTERVAL '\''7 days'\'' AND model_version = '\''qwen3-4b-ctx4k'\'';"'
# Should match expected cycle volume.

docker compose stop ollama
sleep 360
docker exec mailbox-postgres-1 psql -U mailbox -d mailbox -tAc \
  "SELECT created_at, category, model_version FROM mailbox.classification_log
   ORDER BY created_at DESC LIMIT 3;"
# Confirm classifies are still landing AND model_version still reads qwen3-4b-ctx4k.

# Compose retirement step (only after the 7-day green soak): delete the `ollama:`
# block; `docker compose up -d --remove-orphans`. Commit with rationale.
```

**Embedding callout (unchanged from v0.1.0):** retiring Ollama kills `nomic-embed-text`. RAG ingestion stops working unless either (a) llama.cpp serves embeddings (not in DR-25 scope) or (b) a stripped Ollama is left running just for embeddings. **Recommended for first execution: skip step 9, leave Ollama running for embeddings, file a successor ticket.**

---

## §10. Rollback (if any SM-66..70 metric fails, OR if drafts look qualitatively worse)

```bash
ssh mailbox2
cd ~/mailbox

# 10a. Flip env back
sed -i 's|^LOCAL_INFERENCE_RUNTIME=.*|LOCAL_INFERENCE_RUNTIME=ollama|' .env

# 10b. Recreate dashboard to pick up the env
docker compose up -d mailbox-dashboard

# 10c. Stop llama-cpp (saves ~3.0 GiB GPU)
docker compose stop llama-cpp

# 10d. Confirm Ollama is taking traffic (v0.2 — schema fix)
sleep 360
docker exec mailbox-postgres-1 psql -U mailbox -d mailbox -tAc \
  "SELECT created_at, category, model_version FROM mailbox.classification_log
   ORDER BY created_at DESC LIMIT 3;"
# `model_version` should now read `qwen3:4b-ctx4k` (Ollama tag style) again.

# 10e. File the failing-metric numbers from §8.2 to STAQPRO-338 + a successor regression issue.
```

The state-transition trigger (STAQPRO-185 migration 009) gives a forensic trail; pull `mailbox.state_transitions` for the affected drafts to cross-check.

---

## §11. Document the result

After §8.2 measurements are in:

1. Edit addendum v0.2 §3.5.5 — replace TBD cells.
2. Flip DR-25 status: "Proposed" → "Implemented" in the same file.
3. Update root `CLAUDE.md` "Active decision records" table.
4. Comment on STAQPRO-338 with the five measurements + soak window.
5. Land **STAQPRO-361** (`llamacpp-client: override hardcoded model: gpt-3.5-turbo with LLAMA_CPP_MODEL`) before T+7 day decommission so `drafts.model` telemetry reads the configured name not the llama.cpp default envelope filler.
6. Commit + push.

---

## Appendix A — M1 historical execution (2026-05-14)

Captured here so the M2 operator inherits operational memory.

| Time (PDT) | Event |
|---|---|
| 2026-05-14 01:46 | `.env.bak-pre-dr25-20260514-014623` snapshot; cutover starts |
| 2026-05-14 01:47 | `mailbox-llama-cpp-1` container created + started (dustynv lineage retagged) |
| 2026-05-14 02:25 (≈09:25 UTC) | Operationally green status memo captured: ~3.0 GiB GPU, 17 t/s decode, 211 t/s prompt fill |
| 2026-05-14 09:08 | `.env` rewritten → `LOCAL_INFERENCE_RUNTIME=ollama` |
| 2026-05-14 09:08:36 | Dashboard restarted (back on Ollama) |
| 2026-05-14 09:08:45 | llama-cpp container stopped (exit 0, clean shutdown via documented rollback path) |

**Reason for revert (per forensics 2026-05-14 afternoon, see `docs/dr25-revert-root-cause-2026-05-14.md`):** two un-applied prerequisites — (A) `dashboard/lib/drafting/router.ts:45` default proxy URL omits the Next.js `/dashboard/` basePath and returns 404; (B) `n8n/workflows/MailBOX-Classify.json:264` was never patched to route through the dashboard SDK proxy, so classify continued to hit Ollama directly. With Ollama up (per the 7-day rollback policy), both failures were transparent. When the operator stopped Ollama to test cutover purity, classify failed immediately. Forced rollback. **Not a quality-driven decision; the llama-cpp runtime itself was working fine** — it just never received production traffic because the routing was broken upstream.

**For the M2 operator:** treat the M1 timeline as evidence the cutover was *staged correctly at the compose layer* (this is what STAQPRO-360 PR captures) but *not yet wired through the request path*. The runbook §0 + §0.5 enumerate the full set of prerequisites; once all are satisfied, M2 can proceed. Confirm with Dustin before re-attempting on M1, since the un-applied prereqs are common to both appliances.

---

## Provenance

- Decision: DR-25 in `dashboard/.planning/spec/addendum-t2-build-validation-v0_2-2026-05-13.md`
- Plan: `docs/plan-staqpro-338-llamacpp-migration-v0_1-2026-05-13.md`
- Predecessor: `docs/runbook/llamacpp-migration.v0.1.0.md`
- Compose changes: STAQPRO-360 (this PR), branch `worktree-staqpro-360`
- Follow-up: STAQPRO-361 (envelope-leak cosmetic fix)
- Linear: https://linear.app/staqs/issue/STAQPRO-338 + https://linear.app/staqs/issue/STAQPRO-360
- Memory cross-links: `[[jetson-memory-diagnostics-orphan-containers]]`, `[[dr25-cutover-landed-m1]]` (the latter superseded by Appendix A)
