# MailBOX One — T2 Build Log

**Version:** v0.4
**Date:** 2026-04-23 (fourth session, same day)
**Hardware:** NVIDIA Jetson Orin Nano 8GB Developer Kit Super
**JetPack:** 6.2 (L4T R36.5)
**Operator:** Dustin
**Supersedes:** v0.3 (same date, earlier session)

---

## Status at a glance

**Infrastructure phase: CLOSED.**
**Appliance is ready for Phase 02 (email-pipeline-core) execution.**

| Component | State | Notes |
|---|---|---|
| Jetson power/clocks | ✅ Pinned (persistent) | MAXN_SUPER + `jetson_clocks.service` |
| Ollama container | ✅ Healthy, 9+ days uptime | `ollama/ollama:latest`, GPU 100% offload |
| Qwen3-4B Q4_K_M | ✅ Loaded, tested, 18.66 t/s | Imported from local GGUF |
| Postgres | ✅ Healthy | user/db/password all `mailbox` |
| Qdrant | ✅ Healthy | |
| n8n | ✅ Healthy + initialized + encryption key set | 0 workflows, 0 credentials — clean canvas |
| Dashboard | ✅ Healthy | |
| SSH to Jetson | ✅ Working + key-auth (if completed) | BL-6 partially closed |
| Secrets backed up | ✅ On Jetson + main box | `~/mailbox/secrets-2026-04-23.md` and `~/.secrets/mailbox/` |

**Blockers to Phase 02: none.**

---

## Changes since v0.3

| Area | v0.3 → v0.4 |
|---|---|
| n8n state | Unknown → **Verified initialized, 0 workflows, 0 credentials** |
| n8n encryption key | Blank (latent risk) → **Real key set, documented, backed up** |
| SSH access | Refused → **Working** (BL-6 partially closed) |
| Secrets documentation | None → **`secrets-2026-04-23.md` on Jetson + copy on main box** |
| Phase 02 readiness | Gated on infra → **Cleared to start** |

---

## Session 4 summary

Verified n8n setup state. Discovered n8n is initialized (owner account exists, schema present) but has zero workflows and zero credentials — the cleanest possible starting state for Phase 02. Used this window to resolve the blank-encryption-key latent risk before any secrets get stored. Fixed SSH access between main box and Jetson, backed up secrets to both machines.

No inference changes. No container recreations beyond n8n picking up the new env var.

---

## Actions taken

### 1. n8n state verification

Checked n8n setup state via HTTP endpoints:

```
curl -s http://localhost:5678/rest/login → {"status":"error","message":"Unauthorized"}
curl -sI http://localhost:5678/setup → HTTP/1.1 404 Not Found
```

Interpretation: `/setup` returning 404 means first-run wizard is already complete. `/rest/login` returning `Unauthorized` (not a redirect) means auth is active. Owner account exists.

Queried postgres for actual content:

```
SELECT COUNT(*) FROM workflow_entity;   → 0
SELECT COUNT(*) FROM credentials_entity; → 0
```

Clean canvas confirmed.

### 2. n8n encryption key set

Previously, `.env` was missing `N8N_ENCRYPTION_KEY`, producing this warning on every `docker compose` invocation:

```
WARN[0000] The "N8N_ENCRYPTION_KEY" variable is not set. Defaulting to a blank string.
```

This is a real latent risk: n8n encrypts stored credentials (IMAP passwords, API keys, OAuth tokens) with that key. Blank key = credentials protected by nothing.

Because `credentials_entity` was empty at this point, we could set a proper key with zero migration cost. Changing the key after credentials exist invalidates all of them.

Actions:

```
cp /home/bob/mailbox/.env /home/bob/mailbox/.env.backup-$(date +%Y%m%d)

# Set key via idempotent sed-or-append pattern
grep -q "^N8N_ENCRYPTION_KEY=" /home/bob/mailbox/.env && \
  sed -i "s|^N8N_ENCRYPTION_KEY=.*|N8N_ENCRYPTION_KEY=<REDACTED>|" /home/bob/mailbox/.env || \
  echo "N8N_ENCRYPTION_KEY=<REDACTED>" >> /home/bob/mailbox/.env

cd /home/bob/mailbox
sudo docker compose up -d n8n
```

Key stored in `~/mailbox/secrets-2026-04-23.md` on the Jetson (chmod 600) and mirrored to `~/.secrets/mailbox/secrets-2026-04-23.md` on the main box.

### 3. SSH access established + BL-6 partially closed

SSH to the Jetson was previously refused. Installed `openssh-server`:

```
sudo apt update
sudo apt install -y openssh-server
sudo systemctl enable --now ssh
```

Verified connectivity from main box via `scp` succeeding. Key-based auth setup optional but recommended:

```
# From main box
[ -f ~/.ssh/id_ed25519 ] || ssh-keygen -t ed25519 -C "bob@bob-TB250-BTC"
ssh-copy-id bob@192.168.1.107
```

**Note:** `nano`/`vim` still not installed on the Jetson. BL-6 remains partially open until both SSH and a base editor are in the T2 provisioning checklist.

### 4. Secrets documentation created

File: `~/mailbox/secrets-2026-04-23.md` on the Jetson (chmod 600), copied to `~/.secrets/mailbox/secrets-2026-04-23.md` on the main box (chmod 600).

Contents:
- n8n encryption key
- Postgres credentials (acknowledged as default-password, fine for single-tenant appliance, documented known non-issue)
- Pointers to `.env` and `.env.backup-*`

**Security note:** The n8n encryption key was shared in an earlier chat session during setup. For true production deployment, rotation would be appropriate. For this dev appliance on a local LAN, current posture is acceptable — flagged for awareness, not action.

---

## Revised open items (carried to v0.5)

| ID | Item | Priority | Notes |
|---|---|---|---|
| BL-3 | Dedupe 3 Qwen3-4B variants | **High** | Must happen before or at start of Phase 02 — first workflow will hardcode a model tag. Recommended: before first Phase 02 plan executes. |
| BL-6 | `openssh-server` + editor in T2 base image provisioning checklist | Low | SSH resolved on this unit; outstanding as a T2 image-spec item. Add to technical PRD provisioning section. |
| BL-7 | Custom jetson-containers build for current Ollama on JetPack 6.2 | Low | Only worth pursuing if 18.66 t/s becomes a user-visible blocker during Phase 02 UX testing. |

**Closed this session:** n8n encryption key hardening, SSH access, secrets backup.

**Earlier closes:** BL-1 (v0.3, not feasible), BL-2 (v0.2, done), BL-4 (v0.3, compose-file correction identified), BL-5 (v0.3, unreachable without BL-7).

---

## Phase 02 entry conditions — all satisfied

| Condition | Status |
|---|---|
| Inference endpoint reachable from n8n | ✅ `http://ollama:11434` inside compose network |
| Model registered with stable tag | ✅ `qwen3:4b` (pending BL-3 dedupe) |
| Baseline throughput documented | ✅ 18.66 t/s — technical PRD to be amended |
| n8n auth + encryption operational | ✅ Owner account + real encryption key |
| Qdrant reachable for RAG | ✅ Healthy container, ports 6333/6334 published |
| Postgres reachable for persistence | ✅ Healthy, mailbox/mailbox/mailbox |
| SSH access for remote operations | ✅ Working |
| Secrets backed up off-device | ✅ Main box has copy |

---

## Next-session kickoff sequence

When you return for Phase 02:

1. **Quick infra sanity (5 min)**
   ```
   ssh bob@192.168.1.107 "cd /home/bob/mailbox && sudo docker compose ps"
   ssh bob@192.168.1.107 "sudo docker exec mailbox-ollama-1 ollama run qwen3:4b --verbose '/no_think ok'" | tail -10
   ```
   Expect all 5 containers healthy, eval rate ≈18.66 t/s. If either fails, stop and diagnose before Phase 02 work.

2. **BL-3 — dedupe Qwen3-4B variants**
   ```
   sudo docker exec mailbox-ollama-1 ollama show qwen3:4b --modelfile
   sudo docker exec mailbox-ollama-1 ollama show qwen3-mailbox:latest --modelfile
   sudo docker exec mailbox-ollama-1 ollama show "hf.co/Qwen/Qwen3-4B-GGUF:Q4_K_M" --modelfile
   ```
   Diff Modelfiles, decide canonical (`qwen3:4b` is the likely winner — clean import, standard tag, current template). Delete the other two. Document the decision in v0.5.

3. **Enter Phase 02 execution** per GSD state (8 PLAN.md files on disk, starting from "Phase 2 UI-SPEC approved"). Each Phase 02 workflow should reference:
   - Ollama via compose service name: `http://ollama:11434`
   - Postgres via compose service name: `postgres:5432` with `mailbox`/`mailbox`/`mailbox`
   - Qdrant via compose service name: `http://qdrant:6333`
   - Model tag: `qwen3:4b` (post-BL-3 canonical)

   Consistency of these references across all 8 plans matters — propose codifying as a convention block in whichever plan document gets executed first.

---

## Session log

| Timestamp (PDT) | Event |
|---|---|
| ~02:50 | Session 4 start — verify n8n state before Phase 02 |
| ~02:52 | Confirmed n8n initialized, no workflows, no credentials |
| ~02:55 | Identified blank-encryption-key latent risk; opportunity to fix cleanly |
| ~03:00 | Encryption key generated and set in `.env`; n8n recreated |
| ~03:05 | SSH installed on Jetson, connectivity verified |
| ~03:10 | `secrets-2026-04-23.md` created on Jetson, copied to main box |
| ~03:15 | Build log v0.4 authored; infrastructure phase formally closed |

---

## T2 production baseline (unchanged from v0.3)

| Spec | Value |
|---|---|
| Hardware | NVIDIA Jetson Orin Nano 8GB Developer Kit Super |
| JetPack | 6.2 (L4T R36.5) |
| Power mode | MAXN_SUPER (persistent) |
| GPU clock pinning | `jetson_clocks.service` (persistent) |
| Inference runtime | `ollama/ollama:latest` via Docker, `runtime: nvidia` |
| Inference model | Qwen3-4B Q4_K_M, 8192 ctx |
| GPU offload | 100% |
| Prompt eval rate | 167–221 t/s |
| Generation rate | 18.66 t/s |
| Per-email latency estimate | 5–17s (100–300 output tokens) |

---

## Related artifacts

- Build log v0.3: `mailbox-one-t2-build-log-v0_3-2026-04-23.md`
- Build log v0.2: `mailbox-one-t2-build-log-v0_2-2026-04-23.md`
- Build log v0.1: `mailbox-one-t2-build-log-v0_1-2026-04-23.md`
- Technical PRD: `thumbox-technical-prd-v2_1-2026-04-16.md` — **needs amendment** (T2 baseline spec, ssh+editor in provisioning checklist)
- Business PRD: `thumbox-business-prd-v2_1-2026-04-16.md`
- Secrets (Jetson): `/home/bob/mailbox/secrets-2026-04-23.md`
- Secrets (main box): `~/.secrets/mailbox/secrets-2026-04-23.md`
- Compose: `/home/bob/mailbox/docker-compose.yml`
- Compose env: `/home/bob/mailbox/.env`
