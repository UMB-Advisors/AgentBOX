# MailBOX One — T2 Build Log

**Version:** v0.1
**Date:** 2026-04-23
**Hardware:** NVIDIA Jetson Orin Nano 8GB Developer Kit Super
**JetPack:** 6.2 (L4T R36.5)
**Operator:** Dustin

---

## Session summary

Local GGUF model import into existing `mailbox-ollama-1` container. Started from a state where `ollama` was not on the host PATH; ended with `qwen3:4b` imported, running at 100% GPU offload inside the existing Docker stack, reachable at `localhost:11434` and consumable by `n8n`, `qdrant`, and `dashboard` services.

Pre-existing stack (brought up ~10 days prior) continued running throughout; no data loss, no container rebuilds, no volume resets.

---

## Starting state

- `ollama` command not found on host (`-bash: ollama: command not found`)
- `mailbox-ollama-1` container already running (`ollama/ollama:latest`, 9 days uptime, healthy)
- GGUF file `Qwen3-4B-Q4_K_M.gguf` downloaded to `/home/bob/` (not in Downloads)
- Network connectivity to GitHub releases: severely degraded (~20 KB/s)
- Existing models in container: `qwen3-mailbox:latest`, `hf.co/Qwen/Qwen3-4B-GGUF:Q4_K_M`, `nomic-embed-text:v1.5`, `qwen2.5:3b`

---

## Actions taken

### 1. Host Ollama install attempt (abandoned)

Attempted to install native Ollama via `curl -fsSL https://ollama.com/install.sh | sh`. Installer aborted mid-download (connection reset at 77%).

Fell back to manual download: identified correct JetPack 6 artifact (`ollama-linux-arm64-jetpack6.tar.zst`, v0.21.1) from GitHub releases API. Download throughput to Jetson was ~20 KB/s (unusable). SSH to Jetson from secondary machine refused (openssh-server not installed). Transferred 248MB zstd tarball via USB sneakernet (`TRAVELDRIVE`) as fastest available path.

Extracted and installed to `/usr/local/bin/ollama` (v0.21.1). Created systemd unit `ollama.service`. Service entered crash loop: `listen tcp 127.0.0.1:11434: bind: address already in use`.

Root cause: `mailbox-ollama-1` container (via Docker port publish on `0.0.0.0:11434`) was already bound to the port. Native install was redundant.

**Disposition:** Abandoned native install path. Removed systemd unit:
```
sudo systemctl disable --now ollama
sudo rm /etc/systemd/system/ollama.service
sudo systemctl daemon-reload
```

Native `/usr/local/bin/ollama` binary left in place (v0.21.1 client can query the container's HTTP API directly; not harmful). Tarball left at `/tmp/ollama-linux-arm64-jetpack6.tar.zst` for reference.

### 2. Container GPU verification

Before importing into the container, confirmed GPU passthrough was functional:

- `docker inspect mailbox-ollama-1 | grep Runtime` → `"Runtime": "nvidia"` ✓
- `docker exec mailbox-ollama-1 nvidia-smi` → `Driver 540.5.0, CUDA 12.6` ✓

### 3. GGUF import into container

Copied GGUF into container:
```
sudo docker cp /home/bob/models/Qwen3-4B-Q4_K_M.gguf \
  mailbox-ollama-1:/root/Qwen3-4B-Q4_K_M.gguf
```

Wrote Modelfile inside container with Qwen3 ChatML template and stop tokens:
```
FROM /root/Qwen3-4B-Q4_K_M.gguf

TEMPLATE """{{ if .System }}<|im_start|>system
{{ .System }}<|im_end|>
{{ end }}{{ if .Prompt }}<|im_start|>user
{{ .Prompt }}<|im_end|>
{{ end }}<|im_start|>assistant
{{ .Response }}<|im_end|>
"""

PARAMETER stop "<|im_start|>"
PARAMETER stop "<|im_end|>"
PARAMETER temperature 0.7
PARAMETER top_p 0.8
PARAMETER top_k 20
PARAMETER num_ctx 8192
```

Imported:
```
sudo docker exec mailbox-ollama-1 ollama create qwen3:4b -f /root/Modelfile
```

Verified via `/api/tags` HTTP endpoint — `qwen3:4b` registered at 2.497 GB, qwen3 family, Q4_K_M.

### 4. GPU clock pinning

Initial benchmark with `/no_think` directive returned 16.5 t/s eval rate. Investigation revealed GPU idling at minimum frequency (306 MHz of 1020 MHz available) despite MAXN_SUPER power mode.

Applied `sudo jetson_clocks` to pin CPU/GPU/EMC to max frequencies. Prompt eval rate doubled (102 → 221 t/s); eval rate improved modestly (16.5 → 18.8 t/s).

Eval rate ceiling is memory-bandwidth-bound (LPDDR5 ~102 GB/s), not compute-bound — so GPU clock pinning helps prompt processing significantly but generation only marginally.

---

## Current benchmark

**Test:** `ollama run qwen3:4b --verbose "/no_think say hello"`

| Metric | Value |
|---|---|
| Total duration | 1.12 s |
| Load duration | 204 ms |
| Prompt eval rate | 221.75 t/s |
| Eval rate | 18.83 t/s |
| Processor | 100% GPU |
| Context | 8192 |

**Interpretation:** Generation-phase throughput (18.83 t/s) is below the ~25–35 t/s range expected for Qwen3-4B Q4_K_M on Orin Nano 8GB with a JetPack-tuned image. Gap is attributed to running generic `ollama/ollama:latest` instead of the compose-specified `dustynv/ollama:0.18.4-r36.4-cu126-22.04`. See Open Items.

**Practical impact at 18.83 t/s:** 100–300 output tokens (typical email triage response) = 5–17 s end-to-end. Acceptable for async IMAP-driven workflows. Borderline for interactive UI where user waits on draft generation.

---

## Configuration drift discovered

`docker-compose.yml` at `/home/bob/mailbox/docker-compose.yml` specifies:
```
image: ${OLLAMA_IMAGE:-dustynv/ollama:0.18.4-r36.4-cu126-22.04}
```

Actually running:
```
ollama/ollama:latest
```

Root cause unknown (possible `.env` override, or manual image swap during earlier build). The compose file reflects the intended state (dustynv JetPack-tuned build); the running container reflects what was actually brought up 10 days ago.

**No immediate impact** — GPU acceleration works in both images because `runtime: nvidia` is set on the service. Performance delta is the concern, not functionality.

---

## Persistence recommendation (not yet applied)

`jetson_clocks` does not persist across reboots. For a production appliance where consistent inference latency matters, recommend installing as a systemd oneshot:

```
sudo tee /etc/systemd/system/jetson_clocks.service > /dev/null << 'EOF'
[Unit]
Description=Pin Jetson clocks to max
After=nvpmodel.service

[Service]
Type=oneshot
ExecStart=/usr/bin/jetson_clocks
RemainAfterExit=yes

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable jetson_clocks.service
```

**Trade-off:** Pinned clocks = consistent response latency at cost of ~15W continuous power draw (vs ~5–8W idle). Correct trade for 24/7 always-on appliance; should be default for T2 production builds.

**Status:** Recommended but not applied in this session. Add to T2 build checklist.

---

## Open items

| ID | Item | Priority | Next action |
|---|---|---|---|
| BL-1 | Swap `ollama/ollama:latest` → `dustynv/ollama:0.18.4-r36.4-cu126-22.04` | Medium | Schedule clean maintenance window; `docker compose pull` then `up -d` ollama service only. `ollama_models` volume will persist. Re-benchmark after. |
| BL-2 | Apply `jetson_clocks.service` systemd unit for reboot persistence | High | Apply before next reboot. Add to T2 launch checklist. |
| BL-3 | Model inventory cleanup — 3 variants of Qwen3-4B present (`qwen3:4b`, `qwen3-mailbox:latest`, `hf.co/Qwen/Qwen3-4B-GGUF:Q4_K_M`) | Low | Diff Modelfiles, determine which is canonical, delete duplicates. Confirm n8n workflows reference the correct tag before deletion. |
| BL-4 | Compose drift — reconcile `OLLAMA_IMAGE` override vs compose default | Low | Identify whether `.env` is setting `OLLAMA_IMAGE=ollama/ollama:latest` or if image was swapped manually. Document intended production image. |
| BL-5 | Eval rate 18.83 t/s vs expected 25–35 t/s on this hardware | Medium | Expected to resolve via BL-1. Re-benchmark post-swap. If still under 25 t/s, investigate EMC/GPU clock state under sustained load. |
| BL-6 | `nano` / `openssh-server` not installed on appliance | Low | Both should be in base T2 image. Add to appliance provisioning checklist. `openssh-server` in particular is needed for any remote ops/debugging. |

---

## Benchmarks to run next session

1. Post-dustynv-swap: same `/no_think` test, compare eval rate. Target ≥25 t/s.
2. Realistic email triage prompt: ~500-token input, request classification + 150-word draft reply. Measure wall-clock and eval rate under that load.
3. Concurrent load test: two parallel inference requests. Verify no thermal throttling, no OOM, no eval rate collapse.
4. Sustained load soak: 20-minute continuous request stream. Measure GPU/CPU thermals, power draw, any t/s degradation over time. This is the most important test for a 24/7 appliance.

---

## Related artifacts

- Technical PRD: `thumbox-technical-prd-v2_1-2026-04-16.md` (MailBOX One hardware spec)
- Business PRD: `thumbox-business-prd-v2_1-2026-04-16.md`
- Compose file: `/home/bob/mailbox/docker-compose.yml`
- Modelfile (in container): `/root/Modelfile`
- GGUF source: `/home/bob/models/Qwen3-4B-Q4_K_M.gguf`

---

## Log

| Timestamp (PDT) | Event |
|---|---|
| 00:47 | Confirmed `ollama` not on host PATH |
| 00:51 | `install.sh` aborted at 77% download |
| 01:04 | Downloaded `ollama-linux-arm64-jetpack6.tar.zst` (248 MB) on secondary machine |
| 01:10 | Transferred via USB (TRAVELDRIVE) to Jetson |
| 01:22 | Installed native Ollama; systemd crash loop begins (port conflict) |
| 01:25 | Root cause identified: `mailbox-ollama-1` holds port 11434 |
| 01:28 | Verified container GPU passthrough (CUDA 12.6, Driver 540.5.0) |
| 01:35 | GGUF copied into container; Modelfile created |
| 01:36 | `ollama create qwen3:4b` completed successfully |
| 01:42 | Initial benchmark: 16.5 t/s eval, `/no_think` working |
| 01:48 | `jetson_clocks` applied; GPU pinned to 1020 MHz |
| 01:49 | Post-pin benchmark: 18.83 t/s eval, 100% GPU confirmed |
| 01:52 | Session end — build log authored |
