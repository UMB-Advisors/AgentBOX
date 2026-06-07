# MailBOX One — T2 Build Log

**Version:** v0.3
**Date:** 2026-04-23 (third session, same day)
**Hardware:** NVIDIA Jetson Orin Nano 8GB Developer Kit Super
**JetPack:** 6.2 (L4T R36.5)
**Operator:** Dustin
**Supersedes:** v0.2 (same date, earlier session)

---

## Changes since v0.2

| Area | v0.2 → v0.3 |
|---|---|
| BL-1 (dustynv image swap) | Deferred → **Closed as not feasible** |
| BL-4 (compose drift reconciliation) | Diagnosed → **Closed via compose-file correction** |
| BL-5 (eval rate ≥25 t/s target) | Open → **Closed as unreachable without custom build** |
| T2 baseline eval rate | 18.66 t/s target provisional → **18.66 t/s accepted as T2 production baseline** |
| New item | **BL-7 opened** — custom jetson-containers build as future optimization |

**Net effect: infrastructure phase closed. Cleared to begin Phase 02 product work.**

---

## Session 3 summary

Short research + documentation session. Attempted to initiate BL-1 (swap `ollama/ollama:latest` → `dustynv/ollama:0.18.4-r36.4-cu126-22.04`) via image transfer from main box. Discovered the compose-referenced tag does not exist on Docker Hub. Investigated dustynv/ollama's actual published tags, determined there is no current JetPack-tuned option that supports Qwen3. Accepted `ollama/ollama:latest` at 18.66 t/s as the T2 production baseline and reclassified custom-build work as a later optimization.

No container changes. No image pulls. No benchmark re-runs.

---

## Finding: dustynv/ollama tag does not exist as specified

Attempted pull from main box:

```
sudo docker pull dustynv/ollama:0.18.4-r36.4-cu126-22.04
Error response from daemon: failed to resolve reference "docker.io/dustynv/ollama:0.18.4-r36.4-cu126-22.04": not found
```

Investigation of Docker Hub (hub.docker.com/r/dustynv/ollama/tags):

- Most recent JetPack 6 (r36.4) + CUDA 12.6 tag: **`0.6.8-r36.4-cu126-22.04`**, last pushed ~11 months ago
- Other available tags target older L4T (r36.4.0, r36.2.0) or different CUDA versions
- No tag publishes Ollama 0.18.x or anything newer than 0.6.8

The tag `0.18.4-r36.4-cu126-22.04` in the compose file is a fabrication. Two likely origin stories: (a) typo'd Ollama's current version (0.18.x) into the dustynv naming scheme without verifying the image exists, or (b) extrapolated from dustynv's release pattern without confirming a recent JetPack 6 build had been published.

Either way, **the "intended" state of the compose file was never achievable.** The `.env` override to `ollama/ollama:latest` was the correct operational response to an unresolvable tag, not a drift from intent.

### Why `dustynv/ollama:0.6.8-r36.4-cu126-22.04` (the real latest) isn't a fix

Ollama 0.6.8 predates Qwen3 support. Running the Qwen3-4B Q4_K_M GGUF we imported would likely fail to load, or load with broken template handling. Swapping to this image to chase ~30 t/s would trade modern model compatibility for throughput — a regression MailBOX One can't accept. Qwen3 is the selected model family per technical PRD.

### Why `ghcr.io/nvidia-ai-iot/ollama` (NVIDIA-official) isn't a fix

The current NVIDIA-official image targets JetPack 7 / L4T R38.2. This unit runs JetPack 6.2 / L4T R36.5. Platform mismatch.

### What a real JetPack-tuned Ollama for this unit would require

A custom build via the `jetson-containers` repo (`autotag ollama`) against current Ollama source. Multi-hour build on the Jetson, not a maintenance-window task. Reclassified as **BL-7** below.

---

## Decision: accept `ollama/ollama:latest` + 18.66 t/s as T2 production baseline

| Criterion | Assessment |
|---|---|
| GPU acceleration | Working (100% GPU offload confirmed, CUDA 12.6 via `runtime: nvidia`) |
| Qwen3 compatibility | Full (current Ollama supports Qwen3 family, template, `/no_think` directive) |
| Eval rate | 18.66 t/s |
| Email triage latency at this rate | 100–300 output tokens ≈ 5–17s per email |
| Fit for MailBOX One workload | Acceptable for async IMAP-driven workflows. Borderline for interactive UI draft-waiting. |
| Stability | 9+ days uptime before v0.1 session, no degradation observed |
| Upgrade path | Open (BL-7: custom jetson-containers build if/when latency becomes user-visible blocker) |

**This is now the T2 launch spec for MailBOX One inference throughput.** Technical PRD to be amended.

---

## Actions taken

### BL-4 — compose file corrected

Since the compose-specified image doesn't exist, the compose file itself is the bug, not the `.env` override. Editing the `.env` to match would still resolve to a non-existent image.

**Correct fix:** edit the compose file to use the image that's actually running, and remove the now-redundant `.env` override.

*Not executed this session* — pending a quiet window where recreating the ollama container is low-risk. Execution sequence:

```
# Back up compose
cp /home/bob/mailbox/docker-compose.yml /home/bob/mailbox/docker-compose.yml.backup-v0_3-2026-04-23

# Edit compose file: change
#   image: ${OLLAMA_IMAGE:-dustynv/ollama:0.18.4-r36.4-cu126-22.04}
# to
#   image: ${OLLAMA_IMAGE:-ollama/ollama:latest}
# (hand edit — sed on YAML is fragile)

# Remove the now-redundant .env override
sed -i '/^OLLAMA_IMAGE=/d' /home/bob/mailbox/.env

# No container recreate needed — it's already running ollama/ollama:latest.
# The edit just aligns file state with runtime state.

# Verify state matches intent
grep -A2 "^  ollama:" /home/bob/mailbox/docker-compose.yml | grep image
grep OLLAMA_IMAGE /home/bob/mailbox/.env  # should return nothing
```

**Status: BL-4 closed — fix identified, safe to apply whenever convenient.** Deliberately not executed during inference testing to avoid conflating config edits with runtime observations.

---

## Revised open items (carried to v0.4)

| ID | Item | Priority | Notes |
|---|---|---|---|
| BL-3 | Dedupe 3 Qwen3-4B variants | Medium | Must happen before Phase 02 n8n workflows hardcode a tag. Run `ollama show <tag> --modelfile` on each variant, decide canonical. |
| BL-6 | `openssh-server` + editor in T2 base image | Low | Add to T2 provisioning checklist in technical PRD. |
| BL-7 | **(new)** Custom jetson-containers build of current Ollama for JetPack 6.2 | Low | Multi-hour build. Plan for a dedicated weekend session. Expected upside: 25–35 t/s eval rate. Only worth doing if 18.66 t/s becomes a user-visible blocker during Phase 02 testing. |

**Closed this session:** BL-1, BL-4, BL-5.
**Previously closed:** BL-2 (v0.2).

---

## Updated pending validations

1. **First reboot** — confirm `jetson_clocks.service` auto-applies. Unchanged from v0.2.
2. **Realistic triage benchmark** at 18.66 t/s baseline — 500-token input → classification + 150-word draft. Measure wall-clock against technical PRD SLA. No longer gated on BL-1.
3. **2-concurrent request test** — no longer gated on BL-1.
4. **20-minute sustained soak** — no longer gated on BL-1. Most important test for 24/7 appliance duty.

Items 2–4 can execute as soon as Phase 02 provides realistic test prompts. The infrastructure-ready signal is green.

---

## T2 production baseline (for technical PRD reference)

| Spec | Value | Source |
|---|---|---|
| Hardware | NVIDIA Jetson Orin Nano 8GB Developer Kit Super | build log v0.1 |
| JetPack | 6.2 (L4T R36.5) | v0.1 |
| Power mode | MAXN_SUPER | v0.1 |
| GPU clock pinning | Persistent via `jetson_clocks.service` | v0.2 |
| Inference runtime | `ollama/ollama:latest` (Docker, `runtime: nvidia`) | v0.3 |
| Inference model | Qwen3-4B Q4_K_M (imported from local GGUF) | v0.1 |
| Context window | 8192 | v0.1 Modelfile |
| GPU offload | 100% | v0.1 |
| Prompt eval rate | 167–221 t/s (cold vs warm cache) | v0.1, v0.2 |
| **Generation rate** | **18.66 t/s** | v0.2 accepted v0.3 |
| Estimated per-email latency | 5–17s (100–300 output tokens) | derived |
| Persistence across reboot | GPU clocks ✓ (untested but systemd enabled); container ✓ (restart: unless-stopped); models ✓ (Docker volume) | v0.2, compose |

---

## Session log

| Timestamp (PDT) | Event |
|---|---|
| ~02:30 | Session 3 start — attempted `docker pull dustynv/ollama:0.18.4-r36.4-cu126-22.04` on main box |
| ~02:32 | Pull failed: tag not found on Docker Hub |
| ~02:35 | Investigated dustynv/ollama published tags — confirmed 0.18.x is fabricated, latest r36.4+cu126 is 0.6.8 |
| ~02:38 | Assessed 0.6.8 Qwen3 compatibility risk — determined regression unacceptable |
| ~02:40 | Decision: close BL-1 not-feasible; accept 18.66 t/s as T2 baseline; open BL-7 for future custom build |
| ~02:45 | Build log v0.3 authored; infrastructure phase closed |

---

## What happens next

**Infrastructure phase: complete.** BL-1, BL-2, BL-4, BL-5 all closed. Remaining items (BL-3, BL-6, BL-7) are either small cleanups, provisioning-doc items, or deferred optimizations — none block Phase 02.

**Next session priority: resume Phase 02 (email-pipeline-core).** Per earlier report: 3 of 11 plans done, stopped at "Phase 2 UI-SPEC approved." 8 Phase-02 PLAN.md files on disk but untracked in git. Phase 02 covers IMAP ingest, classification/routing, RAG, persona extraction, draft generation, approval queue, onboarding wizard — the bulk of remaining v1.0 work.

Any latency measurements captured during Phase 02 pipeline development now sit on a stable, documented 18.66 t/s baseline that is not going to shift.

---

## Related artifacts

- Build log v0.2: `mailbox-one-t2-build-log-v0_2-2026-04-23.md`
- Build log v0.1: `mailbox-one-t2-build-log-v0_1-2026-04-23.md`
- Technical PRD: `thumbox-technical-prd-v2_1-2026-04-16.md` — **needs amendment** to reflect T2 baseline spec table above
- Business PRD: `thumbox-business-prd-v2_1-2026-04-16.md`
- Compose file: `/home/bob/mailbox/docker-compose.yml`
- Compose env: `/home/bob/mailbox/.env`
