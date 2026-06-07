# Runbook — llama.cpp Migration on T2 (STAQPRO-338 / DR-25)

> **Version:** v0.1.0
> **Created:** 2026-05-13
> **Last validated:** TBD (post first on-device execution)
> **Target appliance:** `mailbox1` (M1, `192.168.50.179`, customer #1) — M2 backport is a follow-up
> **Estimated session length:** 90–120 min (30–60 min build/pull + 15 min cutover + 24 h soak observation)
> **Decision record:** DR-25 in `dashboard/.planning/spec/addendum-t2-build-validation-v0_2-2026-05-13.md`
> **Implementation plan:** `docs/plan-staqpro-338-llamacpp-migration-v0_1-2026-05-13.md`

---

## 1. Prerequisites — verify before SSH

Run these on the workstation before connecting to the appliance:

```bash
# 1a. The Stage 1 dashboard code is on master (DR-25 SDK abstraction merged)
git log origin/master --oneline | head -5
# Look for: "feat(llm): SDK HTTP abstraction (...STAQPRO-338...)"
# If absent: STOP. The dashboard build on the appliance won't know what
# LOCAL_INFERENCE_RUNTIME means yet.

# 1b. Eric + Kevin sign-off on the SDK direction (per the issue's "Open" section)
# Look for the approval comment on STAQPRO-338 or in the linked GitHub PR.
# If absent: STOP. Don't ship the runtime swap ahead of the abstraction agreement.

# 1c. The on-appliance mailbox repo is current and clean
ssh mailbox1 'cd ~/mailbox && git status && git log --oneline -3'
# Status should be clean. Recent commits should include the Stage 1 PR merge.

# 1d. Customer-facing health is green right now (don't migrate over a hot incident)
ssh mailbox1 'cd ~/mailbox && docker compose ps && \
  docker exec mailbox-postgres-1 psql -U mailbox -d mailbox -tAc \
  "SELECT count(*) FROM mailbox.drafts WHERE status=\"pending\" AND created_at > now() - interval \"15 minutes\";"'
# All services Up. No backlog of >5 pending drafts in the last 15 min.

# 1e. Decide which GGUF source path to use (DR-25 §8.6.q.4 — recommended: HuggingFace)
# Path 1 (HF): cleaner, decouples from Ollama blob layout. Requires internet from appliance.
# Path 2 (Ollama blob extract): faster, no internet required, tightly coupled to Ollama storage.
```

---

## 2. Capture the baseline before any change

```bash
ssh mailbox1
cd ~/mailbox

# Snapshot the live envelope so §3.5.5 has its pre-DR-25 numbers
mkdir -p ~/dr25-baseline && cd ~/dr25-baseline

# Memory baseline
free -h > free-pre.txt
nvidia-smi --query-gpu=memory.used,memory.free,memory.total --format=csv > gpu-pre.txt
docker stats --no-stream --format 'table {{.Name}}\t{{.MemUsage}}\t{{.CPUPerc}}' > docker-stats-pre.txt

# Generation rate baseline (Ollama side, so we have a side-by-side comparison)
docker exec mailbox-ollama-1 ollama run qwen3:4b-ctx4k --verbose \
  "Reply to a customer asking about order status." 2>&1 | tail -20 > ollama-tokrate-pre.txt

# Cycle latency baseline (last 24h of MailBOX-Classify executions)
docker exec mailbox-postgres-1 psql -U mailbox -d mailbox -tAc \
  "SELECT percentile_cont(0.95) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM (\"finishedAt\"::timestamp - \"startedAt\"::timestamp))) AS p95_seconds
   FROM execution_entity
   WHERE \"workflowId\" = (SELECT id FROM workflow_entity WHERE name='MailBOX-Classify')
     AND \"finishedAt\" > now() - interval '24 hours';" \
  > classify-p95-pre.txt

cat free-pre.txt gpu-pre.txt ollama-tokrate-pre.txt classify-p95-pre.txt
```

**Decision point:** If any baseline reads anomalous (e.g., classify p95 > 9 s already), DO NOT proceed. File a regression issue first.

---

## 3. Build (or pull) llama.cpp ARM64 + CUDA

### 3.1 Preferred path — pull a pre-built image

llama.cpp ships ARM64 + CUDA server images via ghcr.io. Probe first:

```bash
ssh mailbox1
docker manifest inspect ghcr.io/ggml-org/llama.cpp:server-cuda 2>&1 | head -40
# Look for: "architecture": "arm64" and "os.version" matching JetPack 6.2's CUDA 12.6.
# If present:
docker pull ghcr.io/ggml-org/llama.cpp:server-cuda
docker tag ghcr.io/ggml-org/llama.cpp:server-cuda local/llama-cpp:cuda-jetson
```

If the manifest lacks ARM64 + CUDA 12.6 (or fails to start with the expected GPU init log), fall through to source build.

### 3.2 Fallback — build from source on-device

```bash
ssh mailbox1
sudo mkdir -p /opt && sudo chown bob:bob /opt
cd /opt
git clone --depth=1 https://github.com/ggerganov/llama.cpp llama.cpp-src
cd llama.cpp-src

# The CUDA Dockerfile. CUDA_VERSION matches JetPack 6.2 (CUDA 12.6); compute capability
# sm_87 is Orin Nano's Ampere class.
docker build -f .devops/cuda.Dockerfile \
  --build-arg CUDA_VERSION=12.6.0 \
  --build-arg CUDA_DOCKER_ARCH=sm_87 \
  -t local/llama-cpp:cuda-jetson \
  .
```

**Build watch:** 30–60 min on 8 GB Jetson, linker is the slow phase. If the link OOMs (visible as `cc1plus: error: out of memory`), the recovery is:

1. Stop heavy services to free RAM: `cd ~/mailbox && docker compose stop n8n qdrant`
2. Re-run the build
3. After success, restart: `docker compose start n8n qdrant`

Cross-compile fallback (workstation → push to local registry): if on-device build keeps OOM-ing, build on the workstation with `--platform linux/arm64` via buildx and push to a local registry the Jetson can pull. Not detailed here; raise if needed.

### 3.3 Verify the image

```bash
docker run --rm --runtime nvidia local/llama-cpp:cuda-jetson --version
docker run --rm --runtime nvidia local/llama-cpp:cuda-jetson \
  bash -c 'nvidia-smi -L' 2>&1 | head -3
# Expected: "GPU 0: Orin (UUID: ...)" — confirms CUDA passthrough
```

---

## 4. Source the GGUF

### 4.1 Path 1 (recommended): HuggingFace download

```bash
ssh mailbox1
mkdir -p ~/mailbox/llama-cpp-models
cd ~/mailbox/llama-cpp-models

# huggingface-cli may need a one-time pip install on the appliance:
pip install --user huggingface_hub
~/.local/bin/huggingface-cli download Qwen/Qwen3-4B-GGUF qwen3-4b-q4_k_m.gguf \
  --local-dir . --local-dir-use-symlinks False

# Rename to match the llama-cpp compose service's expected filename
mv qwen3-4b-q4_k_m.gguf qwen3-4b-ctx4k.gguf
ls -lh qwen3-4b-ctx4k.gguf
# Expected: ~2.4 GiB
```

### 4.2 Path 2 (fallback): extract from Ollama blob store

```bash
ssh mailbox1

# Resolve the GGUF blob digest from the Modelfile metadata
docker exec mailbox-ollama-1 ollama show qwen3:4b --modelfile | grep '^FROM'
# Output looks like: FROM /root/.ollama/models/blobs/sha256-<digest>

# Copy the blob out of the container
mkdir -p ~/mailbox/llama-cpp-models
docker cp mailbox-ollama-1:/root/.ollama/models/blobs/sha256-<digest> \
  ~/mailbox/llama-cpp-models/qwen3-4b-ctx4k.gguf
ls -lh ~/mailbox/llama-cpp-models/qwen3-4b-ctx4k.gguf
```

Either way, end state: `~/mailbox/llama-cpp-models/qwen3-4b-ctx4k.gguf` exists, ~2.4 GiB.

---

## 5. Stand up the llama-cpp service alongside Ollama

Add this service to `~/mailbox/docker-compose.yml` (do not remove `ollama` yet — 7-day hot rollback policy per DR-25):

```yaml
  llama-cpp:
    image: local/llama-cpp:cuda-jetson
    runtime: nvidia
    container_name: mailbox-llama-cpp-1
    command:
      - "--model"
      - "/models/qwen3-4b-ctx4k.gguf"
      - "--ctx-size"
      - "4096"
      - "--host"
      - "0.0.0.0"
      - "--port"
      - "8080"
      - "--n-gpu-layers"
      - "99"
      - "--no-mmap"
      - "--slots"
    environment:
      LLAMA_LOG_LEVEL: "info"
    volumes:
      - ./llama-cpp-models:/models:ro
    # No ports: block — internal docker network only, matches M2's tighter
    # binding model. Workstation access is via tailnet+ssh tunnel.
    restart: unless-stopped
    depends_on: []
```

Bring it up:

```bash
cd ~/mailbox
docker compose up -d llama-cpp

# Watch the load
docker logs -f mailbox-llama-cpp-1
# Expected sequence:
#   load_model: loading model '/models/qwen3-4b-ctx4k.gguf' ...
#   ggml_cuda_init: found 1 CUDA devices: Orin (sm_87) ...
#   llama_new_context_with_model: n_ctx = 4096 ...
#   main: server is listening on http://0.0.0.0:8080
# Cold load: 10-25 s.
```

Sanity-check health:

```bash
ssh mailbox1 'docker exec mailbox-llama-cpp-1 curl -s http://localhost:8080/health'
# Expected: {"status":"ok"} or similar
```

Memory snapshot at this point:

```bash
nvidia-smi --query-gpu=memory.used --format=csv
docker stats --no-stream mailbox-llama-cpp-1 mailbox-ollama-1
# Both runtimes live. Combined usage should be ~6.0-6.8 GiB. Brief side-by-side
# window — don't run customer traffic with both up for more than the validation
# loop below.
```

---

## 6. Pre-cutover envelope diff — 20-sample classify comparison

This is the gate per §11 risk-register row "Envelope drift between Ollama and llama.cpp responses."

```bash
ssh mailbox1
cd ~/dr25-baseline

# Fire 20 identical classify calls at both runtimes and diff the response envelopes.
# (The dashboard's /api/internal/classification-prompt route assembles the prompt;
# we call it once and replay against both runtimes.)
curl -s -X POST http://localhost:3001/api/internal/classification-prompt \
  -H 'content-type: application/json' \
  -d '{"from":"alice@example.com","subject":"order status","body":"hi when does my order ship?"}' \
  > classify-payload.json

# Strip dashboard wrapping so we get the raw Ollama-shape body
cat classify-payload.json
# Should include: {prompt, model, stream:false, options:{...}}

# Ollama side (existing path)
for i in $(seq 1 20); do
  curl -s -X POST http://localhost:11434/api/generate \
    -H 'content-type: application/json' \
    -d @classify-payload.json >> classify-ollama-responses.ndjson
  echo >> classify-ollama-responses.ndjson
done

# llama-cpp side via the dashboard proxy (proves the proxy envelope translation works)
LOCAL_INFERENCE_RUNTIME=llama-cpp \
  # NB: env above is for the proxy's runtime selection — set this on the dashboard
  # container by temporarily flipping the env and restarting only the dashboard,
  # or by curling directly at llama-cpp and translating client-side. Cleanest:
  # bring up a one-off dashboard with the env flipped (Stage 3 step 6 dry-run).
  echo "Run the dashboard with LOCAL_INFERENCE_RUNTIME=llama-cpp before this step."

for i in $(seq 1 20); do
  curl -s -X POST http://localhost:3001/api/internal/llm/api/generate \
    -H 'content-type: application/json' \
    -d @classify-payload.json >> classify-llamacpp-responses.ndjson
  echo >> classify-llamacpp-responses.ndjson
done

# Diff the envelope fields the classify-normalize route actually reads
jq -c '{response: .response, done: .done, eval_count: .eval_count, prompt_eval_count: .prompt_eval_count}' \
  classify-ollama-responses.ndjson > envelope-ollama.json
jq -c '{response: .response, done: .done, eval_count: .eval_count, prompt_eval_count: .prompt_eval_count}' \
  classify-llamacpp-responses.ndjson > envelope-llamacpp.json

# Compare — `response` content may differ (sampling), but the SHAPE must match.
# All fields must be present and typed identically on both sides.
diff <(head -1 envelope-ollama.json | jq 'keys') \
     <(head -1 envelope-llamacpp.json | jq 'keys')
# Expected: no diff. Field set must match.
```

**Decision point:** If the field-set diff is non-empty, STOP. The proxy's envelope translation has a gap; fix `dashboard/lib/llm/llamacpp-client.ts` and re-test. Do not proceed to step 7.

---

## 7. Cutover — flip `LOCAL_INFERENCE_RUNTIME`

Single-minute window:

```bash
ssh mailbox1
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

# 7c. Apply via dashboard container recreate (not just restart — env must be re-baked)
docker compose up -d mailbox-dashboard

# 7d. Confirm the dashboard re-read the env
docker exec mailbox-dashboard sh -c 'echo "runtime=$LOCAL_INFERENCE_RUNTIME url=$LLAMA_CPP_BASE_URL model=$LLAMA_CPP_MODEL"'
# Expected: runtime=llama-cpp url=http://llama-cpp:8080 model=qwen3-4b-ctx4k
```

**Dark window:** ~30–60 s during the dashboard recreate (Next.js cold start). The next 5-min n8n cycle (worst case) drops one cycle, recovered by message-id dedup on the cycle after.

---

## 8. Observe — two cycles + 24-hour soak

### 8.1 Immediate (next 15 min)

```bash
# Watch n8n executions for green
ssh mailbox1 'docker exec mailbox-postgres-1 psql -U mailbox -d mailbox -tAc \
  "SELECT id, status, mode, EXTRACT(EPOCH FROM (\"finishedAt\"-\"startedAt\")) AS dur_s
   FROM execution_entity
   WHERE \"workflowId\" IN (SELECT id FROM workflow_entity WHERE name LIKE \"MailBOX%\")
   ORDER BY \"startedAt\" DESC LIMIT 10;"'

# Watch classify-log for fresh inserts
ssh mailbox1 'docker exec mailbox-postgres-1 psql -U mailbox -d mailbox -tAc \
  "SELECT created_at, classification, confidence, model
   FROM mailbox.classification_log ORDER BY created_at DESC LIMIT 5;"'
# `model` should now read `qwen3-4b-ctx4k` (no `:` prefix — the llama.cpp model name
# convention differs from Ollama's tag style). This is the smoking-gun indicator
# the cutover took effect.
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
# Compare tokens/s vs `ollama-tokrate-pre.txt` baseline. Acceptance: ≥ 18.66 t/s.

# SM-67: Cycle latency p95 over the past 24h
docker exec mailbox-postgres-1 psql -U mailbox -d mailbox -tAc \
  "SELECT percentile_cont(0.95) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM (\"finishedAt\"::timestamp - \"startedAt\"::timestamp))) AS p95_seconds
   FROM execution_entity
   WHERE \"workflowId\" = (SELECT id FROM workflow_entity WHERE name='MailBOX-Classify')
     AND \"finishedAt\" > now() - interval '24 hours';"
# Acceptance: ≤ 9 s

# SM-68: Memory
nvidia-smi --query-gpu=memory.used --format=csv
cat /proc/$(pgrep -f 'llama-server')/status | grep VmRSS
# Acceptance: combined llama-cpp model + KV ≤ 4.0 GiB

# SM-69: OOM-killer events
docker logs mailbox-llama-cpp-1 2>&1 | grep -iE 'killed|oom' || echo "no OOM events"
dmesg | grep -iE 'out of memory|oom-killer' || echo "no kernel OOM events"
# Acceptance: 0 events

# SM-70: Cycle success rate
docker exec mailbox-postgres-1 psql -U mailbox -d mailbox -tAc \
  "SELECT
     (SELECT count(*) FROM mailbox.classification_log WHERE created_at > now() - interval '24 hours')::float /
     NULLIF((SELECT count(*) FROM execution_entity WHERE \"workflowId\" = (SELECT id FROM workflow_entity WHERE name='MailBOX-Classify') AND \"finishedAt\" > now() - interval '24 hours'), 0)
     AS success_ratio;"
# Acceptance: ≥ 0.99
```

Record all five numbers into the addendum v0.2 §3.5.5 table (replace "TBD" cells), commit the file, push.

---

## 9. Decommission Ollama (T+7 days post-green-soak)

7-day rollback window per DR-25. After 7 days of green metrics, stop and remove the Ollama container to reclaim ~3.4 GiB:

```bash
ssh mailbox1
cd ~/mailbox

# 9a. Confirm 7 days of green
docker exec mailbox-postgres-1 psql -U mailbox -d mailbox -tAc \
  "SELECT count(*) FROM mailbox.classification_log WHERE created_at > now() - interval '7 days' AND model = 'qwen3-4b-ctx4k';"
# Should match expected cycle volume (~2016 classifies at 5-min cadence, modulo
# empty cycles and live-gate halts).

# 9b. Stop Ollama
docker compose stop ollama

# 9c. Confirm classify still works (proves we weren't accidentally fallback-routing)
sleep 360  # wait one cycle
docker exec mailbox-postgres-1 psql -U mailbox -d mailbox -tAc \
  "SELECT created_at, classification, model FROM mailbox.classification_log ORDER BY created_at DESC LIMIT 3;"

# 9d. If green, remove from compose
# Edit docker-compose.yml: delete the `ollama:` service block.
# Commit the compose change with rationale: "DR-25 7-day green soak passed; Ollama retired from T2."
git add docker-compose.yml
git commit -m "chore(infra): retire ollama service from T2 (DR-25 7-day green soak passed)"
docker compose up -d --remove-orphans
```

**Embedding callout:** This step kills `nomic-embed-text` along with Ollama. RAG ingestion stops working until either (a) llama.cpp serves embeddings, or (b) a separate `ollama` container is left running ONLY for embeddings. DR-25 §8.6.q does not migrate embeddings; **the cleanest interim state is "Ollama retained for embeddings only" — `nomic-embed-text:v1.5` running on a stripped-down Ollama container**. Decision deferred; for now (v0.1 of this runbook) Step 9 stops Ollama entirely and assumes the operator either (i) accepts a RAG outage until the embeddings migration ticket lands, or (ii) skips step 9 and leaves Ollama running for embeddings. **Recommended for first execution: skip step 9, leave Ollama running for embeddings, file a successor ticket for the full retirement.**

---

## 10. Rollback (if any SM-66..70 metric fails)

```bash
ssh mailbox1
cd ~/mailbox

# 10a. Flip env back
sed -i 's|^LOCAL_INFERENCE_RUNTIME=.*|LOCAL_INFERENCE_RUNTIME=ollama|' .env

# 10b. Recreate dashboard to pick up the env
docker compose up -d mailbox-dashboard

# 10c. Stop llama-cpp (saves ~3.4 GiB)
docker compose stop llama-cpp

# 10d. Confirm Ollama is taking traffic
sleep 360
docker exec mailbox-postgres-1 psql -U mailbox -d mailbox -tAc \
  "SELECT created_at, classification, model FROM mailbox.classification_log ORDER BY created_at DESC LIMIT 3;"
# `model` should now read `qwen3:4b-ctx4k` again.

# 10e. File regression issue with the failing metric numbers from §8.2
```

The state-transition trigger (STAQPRO-185 migration 009) gives a forensic trail; pull `mailbox.state_transitions` for the affected drafts to cross-check.

---

## 11. Document the result

After §8.2 measurements are in:

1. Edit `dashboard/.planning/spec/addendum-t2-build-validation-v0_2-2026-05-13.md` §3.5.5 — replace TBD cells with measured values.
2. Flip DR-25 status from "Proposed" → "Implemented" in the same file's Decision Record section.
3. Update root `CLAUDE.md` "Active decision records" table — change DR-25 row's status note.
4. Comment on STAQPRO-338 with the five measurements + soak window.
5. Commit + push.

---

## Provenance

- Decision: DR-25 in `dashboard/.planning/spec/addendum-t2-build-validation-v0_2-2026-05-13.md`
- Plan: `docs/plan-staqpro-338-llamacpp-migration-v0_1-2026-05-13.md`
- Linear: https://linear.app/staqs/issue/STAQPRO-338
- Downstream-blocked: STAQPRO-342 (bake-off), STAQPRO-345, 346, 347, 350
