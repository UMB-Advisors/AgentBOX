# Pitfalls Research

**Domain:** AI Email Agent Appliance — Jetson Orin Nano / Docker Compose / Ollama / n8n / Qdrant / RAG
**Researched:** 2026-04-02
**Confidence:** HIGH (most pitfalls verified via official NVIDIA forums, GitHub issues, n8n community, and official docs)

---

## Critical Pitfalls

### Pitfall 1: Docker 28.x Breaks GPU Passthrough on JetPack 6.2

**What goes wrong:**
Docker 28.0.0 (released February 2025) is incompatible with the Jetson 6.2 kernel. After a routine `apt upgrade`, the daemon fails to start or loses NVIDIA runtime detection. GPU passthrough silently breaks — Ollama and other inference containers fall back to CPU with no obvious error.

**Why it happens:**
Docker's upstream release schedule does not track Jetson kernel releases. The `docker.io` package from JetPack-compatible sources is not the same as `docker-ce` from Docker Inc. If a standard `apt upgrade` runs without pinned packages, Docker 28 gets installed, breaking the kernel module dependency chain.

**How to avoid:**
- Use the JetsonHacks `install_nvidia_docker.sh` script, which pins Docker at 27.5.1
- After install, mark packages on hold: `sudo apt-mark hold docker-ce docker-ce-cli containerd.io`
- Never run `apt upgrade` unattended on the appliance OS without testing Docker GPU passthrough afterward
- Add `/etc/docker/daemon.json` with `"default-runtime": "nvidia"` as part of first-boot provisioning
- Verify GPU is visible inside containers: `docker run --rm --runtime nvidia nvidia-smi`

**Warning signs:**
- Ollama logs show "0 GPU layers" or inference time 10x slower than expected
- `docker info | grep -i runtime` no longer shows nvidia
- Any unplanned Docker version upgrade visible in `apt list --upgradable`

**Phase to address:** Phase 1 (Infrastructure / Docker Compose stack setup)

---

### Pitfall 2: Ollama Falls Back to CPU on Unified Memory Exhaustion — Silently

**What goes wrong:**
The Jetson Orin Nano uses unified CPU/GPU memory. When other processes (Qdrant, n8n, Postgres) consume memory, Ollama's NVML detection returns `NVML_ERROR_NOT_SUPPORTED` and falls back to reading `/proc/meminfo`. If total available RAM appears insufficient (even when the GPU could handle the model), Ollama silently runs all inference on ARM CPU cores at 10-15x slower throughput. There is no clear "running on CPU" warning in default logs.

**Why it happens:**
Ollama was designed for discrete GPU systems where VRAM and system RAM are separate pools. On unified memory SOCs like Tegra/Jetson, its heuristics misfire. Memory fragmentation compounds this: even with 3.8GB nominally free, the largest contiguous block may be only 4MB — triggering CUDA allocation failure (`unable to allocate CUDA0 buffer`). This was a known kernel bug in r36.4.x (JetPack 6.2.0/6.2.1).

**How to avoid:**
- Run JetPack 6.2.2 (r36.5) or later — the memory fragmentation bug in r36.4.7 is fixed
- Set `OLLAMA_NUM_GPU=99` environment variable to force GPU layer loading
- Reserve memory headroom: configure Docker memory limits so Qdrant + Postgres + n8n collectively stay under 3GB, leaving 4-5GB for Ollama
- Monitor with `tegrastats` during inference; expect ~2-4GB GPU memory use for Qwen3-4B Q4_K_M
- After container start, verify: `curl localhost:11434/api/show -d '{"name":"qwen3:4b"}' | jq .model_info` and check `num_gpu_layers > 0`

**Warning signs:**
- Email classification taking >15 seconds (GPU path should be 2-4s for Qwen3-4B)
- `tegrastats` showing GPU util at 0% during inference requests
- n8n workflow timeouts on the classification step
- Container memory usage for non-Ollama services creeping above 3GB total

**Phase to address:** Phase 1 (Infrastructure) and Phase 2 (LLM inference integration)

---

### Pitfall 3: n8n IMAP Trigger Silently Drops Emails (10% Miss Rate)

**What goes wrong:**
The n8n IMAP Email Trigger node has a documented ~10% email miss rate under production conditions, verified in multiple community threads as of 2025. More critically, the trigger silently stops firing entirely after 30-60 minutes of operation — no error, no alert, the workflow simply ceases processing new mail. Users discover it when the approval queue hasn't updated in an hour.

**Why it happens:**
IMAP is a stateful connection protocol. The n8n IMAP node holds a persistent connection that can silently die (TCP timeout, server-side idle disconnect, network hiccup). Without forced reconnect, n8n does not detect the dead connection. Additionally, after n8n version 1.183.2, manually re-marked unread emails stopped triggering the node — only freshly delivered emails with today's internal date trigger correctly.

**How to avoid:**
- Enable "Force Reconnect Every Minutes" in the IMAP node options — set to 5-10 minutes
- Add a watchdog workflow: a scheduled trigger that checks the last-processed email timestamp and sends an alert if >15 minutes without activity during business hours
- Design the pipeline so the IMAP node only triggers the workflow — use a separate polling workflow as a redundancy fallback (poll the last N unread emails on a 5-minute schedule)
- Keep n8n version pinned and test IMAP behavior after every upgrade before deploying to dogfood

**Warning signs:**
- Approval queue shows no new items for >15 minutes during active email hours
- n8n execution log shows IMAP workflow "waiting" but no recent executions
- Customer reports missing emails that never appeared in the queue

**Phase to address:** Phase 2 (Email connectivity) and Phase 3 (Pipeline reliability / monitoring)

---

### Pitfall 4: Gmail OAuth App Review Blocks Deployment for Weeks

**What goes wrong:**
Creating a Gmail OAuth2 app for IMAP/SMTP requires going through Google's OAuth consent screen review. For "external" app type (any non-Workspace app), Google requires a privacy policy URL, scopes justification, and review — which takes 1-6 weeks and can be rejected. This blocks testing and first-time customer onboarding.

**Why it happens:**
Google's OAuth review process treats any third-party app requesting mail scopes as high-risk. The `https://mail.google.com/` IMAP scope is classified as a restricted scope requiring verification. Developers discover this only after building the OAuth flow and attempting to authorize a non-test account.

**How to avoid:**
- For initial dogfood (Heron Labs inbox): use "Testing" mode OAuth app with Dustin's Google account added as test user — bypasses review entirely, supports up to 100 test users
- For customer onboarding: provide pre-built OAuth client credentials (bundled in the appliance), pre-reviewed under Glue Co's GCP project, with privacy policy at a stable URL
- As a fallback: offer Gmail App Password + IMAP as an alternative for customers who don't want OAuth friction — App Passwords require 2FA but have no review process
- Document the Outlook path: Microsoft's OAuth for IMAP is less restrictive and does not require equivalent review

**Warning signs:**
- Google OAuth consent screen shows "Needs verification" banner
- Authorization attempt returns `access_denied` with `unverified_app` reason
- First customer onboarding blocked at email connection step

**Phase to address:** Phase 1 (Email connectivity design) — decide OAuth strategy before writing auth code

---

### Pitfall 5: LLM Classification Returns Invalid JSON / Wrong Category — No Guardrails

**What goes wrong:**
Qwen3-4B with Q4_K_M quantization can produce malformed JSON or hallucinate category names outside the defined 8-category taxonomy, especially on short or ambiguous emails. Without structured output enforcement, the n8n workflow receives unparseable responses, throws an error, and the email silently falls into an unhandled state (neither queued for approval nor escalated).

**Why it happens:**
4B parameter models at Q4_K_M quantization are capable but not reliable at following JSON schemas under all conditions. Qwen3 has a "thinking" mode that produces chain-of-thought tokens before the JSON output — if the workflow parses the raw response without stripping the `<think>...</think>` block, JSON parsing fails. Models also drift on edge cases: empty subject lines, HTML-only bodies, non-English text.

**How to avoid:**
- Use Ollama's structured output (format parameter) with a JSON schema for classification responses — Ollama supports this as of 0.3.x
- Set `temperature: 0` for classification tasks to maximize determinism
- For Qwen3: either explicitly disable thinking mode (`/no_think` in system prompt) or strip the `<think>` block in n8n before JSON parsing
- Implement a category validation node in n8n: if the returned category is not in the allowed set, default to "unknown" and flag for review rather than throwing an error
- Add a retry node: on JSON parse failure, retry once with a simplified prompt; on second failure, classify as "escalate"
- Test with the actual Heron Labs corpus before declaring classification working — synthetic test emails hide real-world failure modes

**Warning signs:**
- n8n execution errors on the "parse classification" node
- Unusual spike in "unknown" category emails
- Classification latency variance > 5x (thinking mode producing long chains)

**Phase to address:** Phase 2 (Classification pipeline) — implement guardrails before testing accuracy

---

### Pitfall 6: Qdrant Memory Map Files Cause Disk I/O Thrash Under Docker Resource Limits

**What goes wrong:**
Qdrant uses memory-mapped files for vector storage. Under Docker memory constraints, the OS kernel may swap or evict these memory maps, causing extreme disk I/O and response latencies of seconds instead of milliseconds during RAG retrieval. This degrades the entire appliance experience, not just search.

**Why it happens:**
On a system with 8GB unified RAM shared across 5 Docker containers, the OS memory pressure causes kernel page reclaim to compete with Qdrant's mmap usage. Qdrant's default storage configuration (`mmap_threshold`) causes vectors above a certain collection size to use mmap automatically, and the threshold may be crossed during normal email history ingestion (6 months of sent email can be thousands of vectors).

**How to avoid:**
- Set explicit Docker `mem_limit` for each service in docker-compose.yml; do not leave memory unconstrained
- Configure Qdrant's `storage.performance.max_search_threads` to 1-2 (not the default auto-detect of core count) to prevent CPU thrash on the ARM cores
- Start with `on_disk: false` for collections during development; enable `on_disk: true` only for archival collections not queried frequently
- Monitor collection memory usage: `GET http://localhost:6333/collections/{name}` shows `vectors_count` and index size
- Set `hnsw_config.on_disk: false` for the active email collection — keep the HNSW graph in RAM

**Warning signs:**
- Qdrant search latency >500ms (baseline with nomic-embed-text should be <50ms for small collections)
- High `iowait` in `htop` or `tegrastats` during email processing
- Docker container memory usage for Qdrant growing unbounded

**Phase to address:** Phase 2 (RAG pipeline) — configure memory limits from the start

---

### Pitfall 7: OTA Update Bricks the Appliance with No Recovery Path

**What goes wrong:**
A customer-initiated OTA update that pulls a broken container image (failed build, incompatible n8n schema migration, corrupted GHCR push) leaves the appliance in a non-functional state. Because the appliance is LAN-only in v1, remote remediation is impossible. Physical access or a support visit costs margin-destroying time.

**Why it happens:**
Container-pull-and-restart OTA is not atomic. If the new image starts but the Postgres schema migration fails, the database is in a partially migrated state that neither the old nor the new image can read. GHCR does not validate image health before flagging a tag as "latest."

**How to avoid:**
- Tag OTA releases explicitly (e.g., `v1.2.3`), never use `latest` as the production pull target
- Implement a pre-update health check: download new image, run smoke test in parallel container before replacing running service
- Run Postgres schema migrations as separate idempotent steps before swapping containers
- Keep the previous image version on-device: only `docker rmi` old images after the new version passes a post-update health check
- Store a "last known good" tag in a local file; add a recovery boot option that reverts to this tag
- Test every OTA path in staging (a second Jetson unit) before releasing to beta customers

**Warning signs:**
- Customer-initiated update that takes longer than 5 minutes (image pull + restart should be <3 minutes on typical home broadband)
- Dashboard not reachable 10 minutes after update completion
- Postgres container in restart loop after update

**Phase to address:** Phase 4 (OTA / update infrastructure) — design recovery before first customer OTA

---

## Technical Debt Patterns

| Shortcut | Immediate Benefit | Long-term Cost | When Acceptable |
|----------|-------------------|----------------|-----------------|
| Skip Docker resource limits (no `mem_limit`) | Simpler compose file, one less config concern | Any container can OOM-kill others; Ollama or n8n can consume all 8GB unexpectedly | Never — add limits in Phase 1 |
| Use `latest` tag for all container images | Always gets newest features automatically | Uncontrolled upgrades break GPU runtime, n8n IMAP behavior, Qdrant API | Never in production; fine in early dev |
| Hardcode email credentials in n8n workflow JSON | Faster initial setup | Credentials exposed in workflow exports, GHCR image layers, logs | Never — use n8n credential manager from day 1 |
| Single monolithic n8n workflow (>20 nodes) | Easier to visualize end-to-end flow | Debugging impossible; n8n performance degrades above 14 nodes; can't reuse subflows | OK for prototype only, refactor before dogfood |
| Skip watchdog / health monitoring | Fewer services to maintain | Silent failures (IMAP trigger death, CPU fallback) go undetected for hours | Never — 2-node watchdog workflow costs 30 minutes |
| Poll IMAP every 10+ seconds to reduce load | Lower server-side request rate | Email latency SLA (30s local path) becomes impossible to meet reliably | OK only if email volume is <5/hour |
| Store Qdrant vectors without `on_disk` configuration | Works out of the box | Memory exhaustion as email history grows; degrades all services | Fine for initial testing; must configure before dogfood |
| Run Jetson in default 10W power mode | Lower thermals, quieter | Qwen3-4B classification takes 10-15s instead of 2-4s; 30s SLA impossible | Never for production — set 25W mode or MAXN SUPER in first-boot |

---

## Integration Gotchas

| Integration | Common Mistake | Correct Approach |
|-------------|----------------|------------------|
| Gmail IMAP | Use account password for IMAP auth | App Password (requires 2FA enabled on account) or OAuth2 — plain password stopped working March 2025 |
| Gmail OAuth2 | Create "External" app type and wait for review | Use "Internal" for Workspace accounts; for consumer Gmail, add test users to bypass review; bundle pre-reviewed OAuth client in appliance |
| Gmail SMTP | Send from the raw SMTP connection with no rate awareness | Rate limit outbound: max 20 emails/hour for free accounts; use exponential backoff on 421/452 responses |
| Ollama REST API | Call `/api/generate` and assume GPU is being used | Always verify with `/api/ps` that the model shows `num_gpu_layers > 0` after first load |
| Ollama + Qwen3 | Parse raw API response as JSON | Strip `<think>...</think>` block first; or use `/no_think` system prompt prefix; or use `/api/chat` with `format: "json"` |
| n8n IMAP node | Trust the trigger will fire reliably | Add watchdog; enable Force Reconnect; add scheduled polling fallback |
| n8n + Ollama node | Use n8n's built-in LLM node with default timeouts | Default HTTP timeout is 30s; Ollama cold-start on first request can take 60s+ (model load); set node timeout to 120s |
| Qdrant + nomic-embed-text | Mix embedding model versions during ingestion and query | Embeddings from different model versions are incompatible; pin `nomic-embed-text` version in Modelfile and never upgrade without re-embedding |
| GHCR OTA | Pull `:latest` and restart | Pin semantic versions; validate image digest before restart; maintain rollback tag |
| Postgres in Docker | No volume mount — data inside container | Always mount `/var/lib/postgresql/data` to a named volume on the NVMe; losing email history on container restart is catastrophic |

---

## Performance Traps

| Trap | Symptoms | Prevention | When It Breaks |
|------|----------|------------|----------------|
| Default Jetson power mode (10W) | Classification takes 10-25s; 30s SLA fails consistently | Set power mode to 25W (`sudo nvpmodel -m 2`) or MAXN SUPER in first-boot script | Immediately on any real workload |
| Ollama model not pre-loaded | First email after idle takes 30-60s (cold model load) | Use `OLLAMA_KEEP_ALIVE=-1` to keep model resident; or send a warmup request at boot | Any time appliance idles (overnight) |
| n8n workflow with >14 nodes sequential | Execution time creeps from 3s to 60s+ | Modularize: split into sub-workflows; use Execute Workflow node | Starts degrading around 10-node mark |
| Qdrant HNSW rebuild during ingestion | Search latency spikes to 5-30s during bulk email import | Disable indexing during bulk ingest (`update_collection` with `indexing_threshold: 0`), then re-enable | Any batch ingest >1000 vectors |
| nomic-embed-text generating embeddings synchronously in n8n | 6-month email history ingest takes hours, blocking other workflows | Run ingestion as a separate background workflow; use batches of 50 emails; add progress tracking | Any corpus >500 emails |
| Postgres storing email bodies in JSONB without size limit | DB grows to fill NVMe; query planning degrades | Store raw email body in a file path, store metadata in Postgres; or truncate body >50KB | At ~50K emails (years of history) |

---

## Security Mistakes

| Mistake | Risk | Prevention |
|---------|------|------------|
| Storing email credentials (IMAP password or OAuth token) in n8n workflow JSON | Credentials leak when workflow exported to JSON, stored in git, or visible in GHCR image | Use n8n's built-in encrypted credential store; never reference credentials inline in workflow nodes |
| Running dashboard on `0.0.0.0:3000` without authentication | Anyone on the LAN (family, office visitors) can approve/send emails as the customer | Require password auth from first boot; implement session tokens; bind to LAN interface only |
| Sending email context (body + contacts) to cloud API without scope control | PII sent to Anthropic includes sensitive business comms; customer trust violation | Implement a context trimmer: strip email addresses/PII before cloud call; only send classification-relevant text and response draft request |
| OAuth refresh token stored in Docker volume without encryption at rest | Stolen NVMe gives full email account access | Encrypt the Docker volume containing n8n's SQLite credential store; or use system keyring via secret management |
| Serving dashboard over HTTP (not HTTPS) on LAN | Credentials and email previews transmitted in plaintext on local network | Use self-signed TLS with mDNS (`device.local`); or accept HTTP for v1 LAN-only with clear documentation of the tradeoff |
| Logging full email body to n8n execution history | Email content visible to anyone with n8n access; execution logs can be large | Use n8n's "Save Execution Data" setting to exclude binary/body data; log only metadata (subject, sender, category, timestamp) |

---

## UX Pitfalls

| Pitfall | User Impact | Better Approach |
|---------|-------------|-----------------|
| Approval queue shows raw LLM draft with no context | Customer doesn't remember the original email; approves wrong draft | Always show: original email thread + draft side by side in the approval card |
| No indication whether a draft was AI-generated locally vs. via Claude cloud | Customer can't assess reliability or cost | Label each draft: "Local (Qwen3)" vs "Cloud (Claude Haiku)" with a subtle badge |
| Auto-send defaults ON for any category | One mistake before trust is built destroys trust completely | Default all categories to "Approval Required"; auto-send is opt-in only, per category, after customer explicitly enables it |
| First-boot wizard allows skipping email history ingestion | RAG quality is terrible; classification personalization is absent; customer thinks product is broken | Make 6-month sent history ingestion a required (not optional) step; show progress clearly; explain why it matters |
| Dashboard shows processing status but not queue depth | Customer doesn't know if the system is working or stuck | Persistent header metric: "X drafts waiting approval / Y processed today" |
| No notification when queue grows beyond threshold | Emails pile up silently for days if customer stops checking | Email digest (daily) + threshold alert (>10 unreviewed after 4h) — both defaulting ON |
| Classification log buried in settings | Customer can't spot misclassification patterns | Surface classification confidence scores in the approval queue; make "wrong category" a one-click correction that feeds back to few-shot examples |

---

## "Looks Done But Isn't" Checklist

- [ ] **Email polling:** IMAP trigger fires for new mail — verify the trigger also fires after n8n has been running for 2+ hours without restarting (the "trigger death" bug manifests after 30-60 min)
- [ ] **GPU inference:** Ollama returns a response — verify `num_gpu_layers > 0` in the model info endpoint; CPU inference looks correct but is 10x slower
- [ ] **OAuth2 Gmail connection:** OAuth flow completes successfully in dev — verify the refresh token survives a 24-hour wait and still works (tokens issued from unverified apps expire at 7 days)
- [ ] **Draft generation:** LLM returns a text string — verify JSON is valid, category is in the allowed taxonomy, `<think>` tokens are stripped, and empty/null responses are handled
- [ ] **RAG retrieval:** Qdrant returns results — verify the embedding used at query time matches the embedding used at ingest time (model version, not just model name)
- [ ] **Approval queue:** Dashboard shows draft — verify the dashboard still shows the draft after page refresh (session persistence) and on mobile viewport
- [ ] **OTA update:** New container image starts — verify Postgres schema migration ran successfully and n8n workflows are intact post-update
- [ ] **First-boot wizard:** Wizard completes — verify email history is actually indexed in Qdrant (check collection vector count) and not just "ingested" by the UI

---

## Recovery Strategies

| Pitfall | Recovery Cost | Recovery Steps |
|---------|---------------|----------------|
| Docker GPU passthrough broken after apt upgrade | MEDIUM | SSH to device; `sudo apt-get install docker-ce=5:27.5.1*`; `sudo apt-mark hold docker-ce`; restart Docker; verify with `docker run --rm --runtime nvidia nvidia-smi` |
| Ollama stuck on CPU (not kernel bug) | LOW | Restart Ollama container; check memory headroom (`free -h`); if other services are consuming too much, restart them first; verify with `tegrastats` |
| n8n IMAP trigger dead (silent failure) | LOW | Restart n8n container; IMAP state resets; emails from missed window are not replayed — check Gmail unread count manually for any missed messages |
| n8n workflow broken after version upgrade | MEDIUM-HIGH | Keep workflow JSON exports in git; roll back n8n container to previous pinned version; restore workflow from export; test IMAP trigger before re-enabling |
| Qdrant collection corrupted or empty after crash | HIGH | Re-run email history ingestion workflow from scratch; this takes hours for large corpora — prevention (regular snapshots via Qdrant snapshot API) is essential |
| OTA update bricked appliance | HIGH | If previous image is still on device: `docker compose up -d` with previous compose file; if not: requires physical access to reflash or pull known-good image via USB ethernet |
| Gmail OAuth token expired/revoked | LOW-MEDIUM | Customer re-authorizes via dashboard OAuth flow; all queued emails resume processing |

---

## Pitfall-to-Phase Mapping

| Pitfall | Prevention Phase | Verification |
|---------|------------------|--------------|
| Docker 28.x GPU breakage | Phase 1: Infrastructure | Run `docker run --rm --runtime nvidia nvidia-smi` — exits 0 with GPU info |
| Ollama CPU fallback | Phase 1 + Phase 2 | `curl /api/ps` shows `num_gpu_layers > 0`; classification latency <5s |
| n8n IMAP silent trigger death | Phase 2: Email connectivity | Run IMAP workflow for 2+ hours; verify execution log shows no gaps; watchdog workflow active |
| Gmail OAuth review blocking | Phase 1: Email connectivity design | OAuth client bundled in appliance; test user auth succeeds without review flow |
| LLM JSON/classification guardrails | Phase 2: Classification pipeline | 100 test emails: zero unhandled parse errors; all categories in valid taxonomy |
| Qdrant memory/mmap thrash | Phase 2: RAG pipeline | `docker stats` shows all containers within budget; Qdrant search <100ms |
| OTA atomic update + rollback | Phase 4: Update infrastructure | Deliberate failed update test recovers automatically to previous version |
| Email credentials in workflow JSON | Phase 2 (day 1) | Export workflow to JSON; grep for password/token strings — should find none |
| Postgres data volume | Phase 1: Infrastructure | Destroy and recreate all containers; verify email history survives |
| Power mode default (10W) | Phase 1: First-boot script | `sudo nvpmodel -q` shows 25W or MAXN mode; classification latency <5s |

---

## Sources

- NVIDIA Developer Forums: [Ollama CUDA memory allocation failure on Jetson Orin Nano](https://forums.developer.nvidia.com/t/ollama-llm-inference-problems-on-jetson-orin-nano-cuda-memory-allocation-failure-and-cpu-memory-error/363574)
- NVIDIA Developer Forums: [Ollama falls back to CPU when other GPU processes running](https://forums.developer.nvidia.com/t/jetson-orin-nano-8gb-docker-issue-ollama-falls-back-to-cpu-when-stable-diffusion-is-running/356279)
- JetsonHacks: [Docker Setup on JetPack 6 — Docker 28 incompatibility, pinning to 27.5.1](https://jetsonhacks.com/2025/02/24/docker-setup-on-jetpack-6-jetson-orin/)
- NVIDIA Developer Forums: [Docker GPU runtime setup issues JetPack 6.2](https://forums.developer.nvidia.com/t/running-ai-docker-containers-on-jetson-orin-nano-with-gpu-support/335561)
- ollama/ollama GitHub: [Qwen3-VL GPU not utilized on Jetson Orin Nano Super JetPack 6.2.1](https://github.com/ollama/ollama/issues/13247)
- ollama/ollama GitHub: [Option to disable CPU fallback for SOC with unified memory](https://github.com/ollama/ollama/issues/10178)
- n8n Community: [IMAP trigger skipping ~10% of emails](https://community.n8n.io/t/imap-trigger-skipping-about-10-of-the-emails/92043)
- n8n GitHub: [IMAP trigger not working after period of time — bug report](https://community.n8n.io/t/n8n-bug-report-imap-trigger-not-working-after-a-period-of-time/47796)
- n8n GitHub: [IMAP trigger doesn't fire for manually marked unread after 1.183.2](https://github.com/n8n-io/n8n/issues/17719)
- Nylas Engineering: [Why Gmail API breaks AI agents — OAuth complexity, rate limits, token refresh](https://cli.nylas.com/guides/why-gmail-api-breaks-ai-agents)
- Google Developers: [Gmail IMAP OAuth2 protocol and quota limits](https://developers.google.com/workspace/gmail/api/reference/quota)
- Film-Tech Forums: [WARNING — Google/Gmail breaks IMAP/POP3 January 2025](https://www.film-tech.com/vbb/forum/main-forum/43448-warning-google-gmail-breaks-imap-pop3-jan-2025-could-break-kdm-automation)
- NVIDIA Technical Blog: [JetPack 6.2 Super Mode — power modes, thermal throttling, 2x inference speedup](https://developer.nvidia.com/blog/nvidia-jetpack-6-2-brings-super-mode-to-nvidia-jetson-orin-nano-and-jetson-orin-nx-modules/)
- Qdrant Documentation: [Memory consumption for vector collections](https://qdrant.tech/articles/memory-consumption/)
- Edge AI and Vision Alliance: [Why edge AI struggles towards production — OTA update failures, deployment gaps](https://www.edge-ai-vision.com/2025/12/why-edge-ai-struggles-towards-production-the-deployment-problem/)
- Latenode: [n8n production reliability — execution time degradation in v1.105-1.106](https://latenode.com/blog/low-code-no-code-platforms/n8n-setup-workflows-self-hosting-templates/n8n-latest-version-2025-release-notes-changelog-update-analysis)
- MichaelItoback: [5 Critical Mistakes to Avoid When Building n8n Workflows](https://michaelitoback.com/building-n8n-workflows/)

---
*Pitfalls research for: AI Email Agent Appliance (Jetson Orin Nano / Docker / Ollama / n8n / Qdrant)*
*Researched: 2026-04-02*
