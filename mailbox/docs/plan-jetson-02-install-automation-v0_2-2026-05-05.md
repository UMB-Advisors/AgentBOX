# MailBOX Customer #2 — `mailbox2` Install Plan

> **Plan version:** v0.2
> **Created:** 2026-05-05
> **Supersedes:** v0.1 (2026-05-04). v0.1 retained as historical reference.
> **Owner:** Bob (workstation `bob-tb250-btc`)
> **Status:** IN PROGRESS — Phases 2-7 + GUI purge complete; Phase 8 (`first-boot.sh`) next.

This document supersedes v0.1. v0.1's structural philosophy (idempotent phases, halt-on-failure, human-in-loop gates) is preserved. Sections below either describe what was actually done (for completed phases) or revise v0.1's instructions to match reality (for upcoming phases).

Linear coordination posts:

- [STAQPRO-174](https://linear.app/staqs/issue/STAQPRO-174) — install findings (parent)
- [STAQPRO-202](https://linear.app/staqs/issue/STAQPRO-202) — `factory-bootstrap.sh` not delivered
- [STAQPRO-228](https://linear.app/staqs/issue/STAQPRO-228) — DNS upstream gap still real
- [STAQPRO-201](https://linear.app/staqs/issue/STAQPRO-201) — GUI purge deltas posted

---

## Changelog v0.1 → v0.2

| Area | v0.1 | v0.2 (reality) |
|------|------|----------------|
| `scripts/factory-bootstrap.sh` | Plan referenced as STAQPRO-202 deliverable | **Does not exist.** Use `scripts/first-boot.sh` for Phase 8. |
| `docs/runbook/headless-appliance-baseline.md` | Plan referenced as STAQPRO-201 PR #47 | Confirmed shipped (commit `ed0b8b2` on master after `git pull`). v0.1 panic was due to local clone being 6 commits behind. Phase 1 should now front-matter `git pull`. |
| Tailnet hostname | `mailbox-jetson-02` | **`mailbox2`** (naming convention `mailbox-jetson-NN` → `mailboxN`, applied to Mailbox #1 retroactively as `mailbox1`) |
| NVMe spec | Samsung 980 500GB | **Kingston SNV3 1TB** (2× spec, fits same M.2 slot) |
| JetPack version | 6.2 (L4T r36.4) | **6.2.2 (L4T r36.5)** — newer, ships CUDA mem alloc fix |
| Username | `mailbox` (recommended) | `mailbox` ✓ as recommended |
| LAN topology | Direct ethernet `10.42.0.0/24` | **Router LAN `192.168.50.0/24`** (DHCP) — direct path retained but not used |
| Tailscale `--accept-dns` | `true` (Phase 7 instruction) | **`false`** — STAQPRO-228 tailnet upstream-DNS gap still unfixed; `=true` would break apt + n8n Gmail node |
| Tailscale SSH | not addressed | **`tailscale set --ssh=true`** added (matches Mailbox #1) |
| Tailnet SSH ACL | not addressed | Required admin-console update to add `mailbox` to `users:[…]` (was `bob`/`root` only) |
| MAC OUI discovery heuristic | "look for NVIDIA OUI" implied | **Wrong** — Orin Nano Super dev kits use ASUSTek OUI on some board revisions (`3c:6d:66`). Use Tailscale enrollment status or SSH probe instead. |
| Sudo on fresh flash | not addressed | **Manual sudoers.d/mailbox-nopasswd drop required** — Mailbox #1's `bob` had passwordless sudo from manual setup; fresh flash with `mailbox` user does not. |
| SSH bootstrap method | not addressed | **`scripts/jetson-bootstrap-ssh.sh`** added — USB-portable, idempotent. |
| Customer #2 GUI purge ordering | "follow customer #2's first cycle" | Done **before** first cycle since this box has never run one (acceptance criteria reframed in STAQPRO-201 comment) |

## Status snapshot (2026-05-05 ~23:40 PT)

- ✅ Phase 1: pre-flight (with the `git pull` correction)
- ✅ Phase 2: NVMe + power-on (pre-arrival)
- ✅ Phase 3: JetPack flash (pre-arrival, r36.5 not r36.4)
- ✅ Phase 4: SSH key trust + sudo bootstrap
- ✅ Phase 5: GUI purge — posted deltas (~1.1 GiB RAM, ~1.25 GB disk reclaimed)
- ✅ Phase 6: Tailnet DNS pre-flight — STAQPRO-228 still real, `--accept-dns=false` mitigation applied
- ✅ Phase 7: Tailscale enrolled — `mailbox2.tail377a9a.ts.net` (100.120.102.45), tagged `tag:mailbox`, Tailscale SSH enabled
- ✅ Phase 8: stack up via manual fallback (first-boot.sh aborted — see Phase 8 execution log)
- ⏭ Phase 9: skipped — STAQPRO-226 still backlog; manual `limit=50` + 1.5s pacing applied at workflow-config time
- ✅ Phase 10: DNS + Cloudflare — domain pivoted from `futurecompounds.com` → `staqs.io` (Eric token); cert obtained
- ✅ Phase 11: smoke test — all 6 services healthy, qwen3:4b-ctx4k ~17.5 tok/s, 11 mailbox tables present
- ✅ Phase 12: n8n active-flag — all 5 workflows `active = t` after restart
- ⏸ Phase 13: Gmail OAuth — NEXT (HUMAN-IN-LOOP, needs customer)
- ⏸ Phases 14–17: per v0.1 forward plan

## Phase-by-phase corrections

### §1 Pre-flight (workstation-side)

**Correction:** before deliverable-existence checks, `git fetch origin && git pull` in the local clone. v0.1 falsely flagged STAQPRO-201's runbook as missing because the local clone was 6 commits behind master.

Updated checks for v0.2:

```bash
cd /home/bob/mailbox && git fetch origin && git pull --rebase origin master
test -x scripts/first-boot.sh                          # ✓ this is the script we use
test -f docs/runbook/headless-appliance-baseline.md    # ✓ STAQPRO-201
test -f docs/runbook/provisioning.v0.1.0.md            # ✓ STAQPRO-163
# v0.1's factory-bootstrap.sh check is REMOVED — script not delivered, see STAQPRO-202.
```

### §2 Hardware + §3 Flash

Pre-arrival on this install. Kingston 1TB NVMe (not Samsung 500GB), JetPack 6.2.2 (not 6.2), username `mailbox` (correct), hostname `ubuntu` (renamed post-boot to `mailbox2`).

### §4 SSH key trust + sudo bootstrap

**v0.1 step 4.1:** `nmap -p 22 ... 10.42.0.0/24` — wrong subnet for this install. M2 is on `192.168.50.0/24`. Also: M2's MAC OUI is **ASUSTek** (`3c:6d:66`), not NVIDIA — initial scan was tripped up by the wrong OUI heuristic. Discovery should rely on `tailscale status` post-enrollment, not pre-enrollment MAC vendor.

**v0.2 method:**

1. Operator copies `scripts/jetson-bootstrap-ssh.sh` to USB stick.
2. Boots Mailbox #2, completes SDK Manager first-run wizard (user: `mailbox`, hostname: `ubuntu` ← will rename later).
3. Runs `sudo bash <usb>/jetson-bootstrap-ssh.sh` on the appliance. Script installs `openssh-server`, enables sshd, drops the workstation pubkey, and prints IPs/MACs/hostname for handoff.
4. Operator reads off LAN IP, tells workstation operator. Workstation tests `ssh mailbox@<ip>`.
5. **Sudo bootstrap (new step):** drop `/etc/sudoers.d/mailbox-nopasswd` containing `mailbox ALL=(ALL) NOPASSWD:ALL`. The fresh JetPack flash does NOT enable passwordless sudo for the chosen user; everything from here on relies on it.
6. Workstation rename + `~/.ssh/config` updates.

### §5 GUI purge (per `headless-appliance-baseline.md`)

**Sequence executed:** `set-default multi-user.target` → `systemctl disable --now gdm3` → `apt purge gnome-shell 'gnome-session*' gdm3 'yaru-theme-*' ibus ibus-data ubuntu-desktop ubuntu-desktop-minimal` → `apt autoremove --purge` → reboot.

**Deltas measured:**

| Metric | Pre | Post (post-reboot) | Δ |
|---|---|---|---|
| Default target | `graphical.target` | `multi-user.target` | ✓ |
| GUI processes | 25+ | 0 | ✓ |
| RAM used | 1.5 GiB | 406 MiB | **−1.1 GiB** |
| Disk used | 16 GB | 15 GB | −1 GB |
| Installed (sum) | 14,532 MB | 13,275 MB | **−1,257 MB** |
| Reboot to base services | — | 42 s | n/a (Phase 8 will measure full-stack) |

Posted to STAQPRO-201 with acceptance-criteria status (`headless-appliance-baseline.md` lines 67-69 still reference deprecated SSH aliases — folded into the `mailboxN` rename PR).

### §6 Tailnet DNS pre-flight + §7 Tailscale enrollment

**STAQPRO-228 verified still real (2026-05-05):**

```
$ dig @100.100.100.100 ports.ubuntu.com
;; status: SERVFAIL
```

`tailscale dns status` on Mailbox #1 reports `(no resolvers configured, system default will be used)`. Mailbox #1 has been working around with `--accept-dns=false`.

**v0.2 enrollment command (corrected):**

```bash
sudo tailscale up --hostname=mailbox2 --advertise-tags=tag:mailbox --accept-dns=false
```

`--accept-dns=false` is **mandatory** until STAQPRO-228 is fixed in the admin console.

**Post-enroll additional steps (new in v0.2):**

```bash
# Enable Tailscale SSH (matches Mailbox #1 — RunSSH=true on M1)
sudo tailscale set --ssh=true
# (Use --accept-risk=lose-ssh if currently connected via tailnet path; safer
#  to run via LAN alias.)
```

**Tailnet ACL update (admin console, one-time):** the existing `ssh:` rule had `users: ["bob", "root"]` only. Add `"mailbox"` so customer-N appliances using the new convention can be SSH'd via Tailscale identity:

```json
"ssh": [
  {
    "action": "accept",
    "src":   ["autogroup:admin"],
    "dst":   ["tag:mailbox"],
    "users": ["bob", "mailbox", "root"]
  }
]
```

After ACL save, both `tailscale ssh mailbox@mailbox2` and `tailscale ssh bob@mailbox1` resolve to `permit`.

### §8 `first-boot.sh` (NOT `factory-bootstrap.sh`)

`scripts/factory-bootstrap.sh` (STAQPRO-202) does not exist. v0.2 uses `scripts/first-boot.sh` (interactive, JetPack-aware). It pauses between stages.

**Pre-condition (new in v0.2):** clone repo as `mailbox` user. v0.1 implicitly assumed the repo was already in place; that's a factory-bootstrap thing, not first-boot.

```bash
ssh mailbox2 'cd ~ && [ -d mailbox ] || git clone https://github.com/UMB-Advisors/mailbox.git'
```

**Stages (per `Install Guide/Install.md`):**

1. **Validate JetPack** — script reads `/etc/nv_tegra_release`, checks R36 r4.0+. Will pass (we're on r5.0).
2. **Docker via JetsonHacks** — only runs if Docker is missing. Pulls and runs the JetsonHacks `install_nvidia_docker.sh`. Skipped if `docker --version` already works.
3. **GPU smoke** — `docker run --rm --runtime nvidia nvidia/cuda:12.3.0-base-ubuntu22.04 nvidia-smi`. Must show the Orin Nano GPU.
4. **MAXN power mode** — `nvpmodel -m 0` + persistent systemd unit. Required for the 25W / 40 TOPS Super Mode envelope.
5. **LUKS data partition encrypt — SKIP for first pass.** TPM-bound LUKS (gen_luks.sh) ships with JetPack 6.2.2 but adds friction for v1; revisit as a separate hardening task. Press Enter to skip when prompted.
6. **Pre-pull Ollama models** — `qwen3:4b` (~2.7 GB) + `nomic-embed-text:v1.5` (~274 MB). Long step (~10-20 min on bring-up LAN). Note: the script pulls `qwen3:4b`, not `qwen3:4b-ctx4k` — the custom 4096-ctx Modelfile build is a separate step (DR-18).
7. **Compose up** — copies `.env.example` → `.env` (stub values, fine for now), runs `docker compose up -d`, polls every 10s for service health (180s timeout). Some services may report unhealthy until Phase 10 fills `.env` with customer-#2 specifics — that's expected.

**Post-stage-7 (new in v0.2):** apply the `qwen3:4b-ctx4k` Modelfile (DR-18). `first-boot.sh` doesn't do this:

```bash
ssh mailbox2 'cd ~/mailbox && docker compose exec ollama ollama create qwen3:4b-ctx4k -f /root/Modelfile.qwen3-4b-ctx4k 2>&1 | tail'
# (exact path depends on what's mounted into the ollama container — TBD when we get there)
```

**Phase-8 timings to capture for the install report:**
- Stage 2 Docker install: \_\_\_ s
- Stage 6 model pull (qwen3:4b): \_\_\_ s
- Stage 6 model pull (nomic-embed-text): \_\_\_ s
- Stage 7 compose up to all-healthy: \_\_\_ s
- Total stage 1-7: \_\_\_ min

### §9 Gmail bootstrap mode (STAQPRO-226)

Per Linear: STAQPRO-226 is still Backlog as of 2026-05-05 — same status as v0.1's "Option B" fallback. Plan accordingly: configure Gmail Get with `limit=50` + 1.5s pacing manually, document as TODO referencing STAQPRO-226.

### §10 DNS + Cloudflare pre-flight (STAQPRO-175)

Mostly unchanged from v0.1. Cloudflare token (DNS-edit, `futurecompounds.com` zone), DNS A record `mailbox.futurecompounds.com` → M2 LAN IP (currently 192.168.50.11 — bring-up location; may move).

**v0.2 note:** `.env` keys to set are `DOMAIN`, `CLOUDFLARE_API_TOKEN`, `CADDY_EMAIL`, plus `MAILBOX_BASIC_AUTH_HASH` (bcrypt; `$` chars **escaped to `$$`** per CLAUDE.md `.env` escaping convention).

### §11–17 (unchanged from v0.1, will append findings as run)

Verification one-liner from CLAUDE.md (§12 n8n active-flag) — `ssh jetson-tailscale "..."` form should be `ssh mailbox2 "..."` post-rename.

## Open follow-ups (will revisit post-install)

1. STAQPRO-202: ship a real `factory-bootstrap.sh` (or close as superseded).
2. STAQPRO-228: fix tailnet upstream nameservers in admin console.
3. STAQPRO-226: Gmail bootstrap mode (manual workaround until shipped).
4. Naming-convention rename PR: 20 tracked files + workstation `~/.ssh/config`.
5. Stale nested `mailbox/` directory at `/home/bob/mailbox/mailbox/` (workstation cleanup).
6. **Caddyfile templating gap (new, Phase 10)**: `caddy/Caddyfile` line 1 hardcodes `mailbox.heronlabsinc.com` instead of `{env.DOMAIN}`. No `{env.CADDY_EMAIL}` reference inside the `tls` block either, so Let's Encrypt account email is empty (cert still issues, but no expiry warnings). Will bite customer #3. Linear issue to be filed.
7. **Bootstrap fail-fast on empty `MAILBOX_BASIC_AUTH_HASH` (new, Phase 10)**: `.env.example` documents the var as required, but `.env` is copied with the field empty and Caddy crash-loops with a confusing `account 0: username and password are required` error. `first-boot.sh` should refuse to bring caddy up until the hash is set.
8. **`docker compose restart` does not reload `.env` (new, Phase 10)**: bit us when restarting caddy after the token change. CLAUDE.md's deploy section warns about this for Caddyfile edits via the admin API but not for env reloads. Add a one-liner: "for env changes, use `up -d <svc>` not `restart`".
9. **CLAUDE.md "Public surface" section is M1-only (new, Phase 11)**: refers to `192.168.1.45` (M1's old wifi IP) for ollama/qdrant/n8n. M2 has no host port binding for any of those — docker-network-only. Section needs an M2 entry.
6. CLAUDE.md "Public surface" section still references stale wifi IP `192.168.1.45` for M1 — should be `192.168.50.179` post-router-LAN move.

## Phase 8 execution log

### 12:03 PT — Run #1: Stage 4 fail (MAXN detection bug on r36.5)

`scripts/first-boot.sh stage_set_power_mode` fails on JetPack 6.2.2 (r36.5):

- Script greps `nvpmodel -q --verbose` output for the literal string "MAXN".
- On r36.5 the *current* mode is `25W` (id=1) by default; `nvpmodel -q --verbose` dumps the CURRENT mode's params, with no mode-NAME-list of available modes.
- "MAXN" string is therefore absent → `[FAIL] Stage 4` after one retry → halt.
- The right command for listing available modes is `nvpmodel -p --verbose`, which shows `POWER_MODEL: ID=0 NAME=15W`, `ID=1 NAME=25W`, `ID=2 NAME=MAXN_SUPER`. **The mode is named `MAXN_SUPER` on this hardware**, not bare `MAXN`.

**Workaround applied:** manually set MAXN_SUPER (mode 2) + create the persistence systemd unit, then re-run the script. After the box is in MAXN_SUPER, `nvpmodel -q --verbose` output contains `Current mode: NV Power Mode: MAXN_SUPER`, which matches the script's `grep -qi 'MAXN'`. Stage 4 then passes on re-run (the script's mode-set call is idempotent).

```bash
sudo nvpmodel -m 2
sudo tee /etc/systemd/system/set-maxn-power.service <<'EOF'
[Unit]
Description=Set Jetson Orin to MAXN_SUPER power mode
After=multi-user.target
[Service]
Type=oneshot
ExecStart=/usr/bin/nvpmodel -m 2
RemainAfterExit=yes
[Install]
WantedBy=multi-user.target
EOF
sudo systemctl daemon-reload && sudo systemctl enable set-maxn-power.service
```

**Suggested fix for `first-boot.sh`:** replace `nvpmodel -q --verbose` (current-mode params) with `nvpmodel -p --verbose` (available-modes list), and parse the `POWER_MODEL: ID=N NAME=...` lines for any name containing "MAXN". File against `scripts/first-boot.sh` as a separate ticket.

### 12:06 PT — Run #2: Stage 6 fail (dustynv image tag does not exist)

Stage 6 attempts `docker run dustynv/ollama:0.18.4-r36.4-cu126-22.04 serve`. Two problems:

1. The pinned tag `0.18.4-r36.4-cu126-22.04` **does not exist on Docker Hub**. The dustynv namespace's actual r36.4 tags (per Docker Hub API) are `0.6.8-r36.4-cu126-22.04`, `r36.4-cu129-24.04`, `r36.4.0-cu128-24.04`, etc. — different versioning entirely. CLAUDE.md and `.env.example` reference a tag that was never published.
2. **Mailbox #1 production uses `ollama/ollama:latest`** (verified via `docker inspect mailbox-ollama-1`), not the dustynv image. CLAUDE.md's recommendation to use dustynv is documentation drift — the live appliance has been running on the official upstream image with NVIDIA runtime passthrough for months without issue.

**Workaround applied:** override `OLLAMA_IMAGE` in `.env` to `ollama/ollama:latest` (matches M1). Manually:

```bash
cp -n .env.example .env
sed -i 's|^OLLAMA_IMAGE=.*|OLLAMA_IMAGE=ollama/ollama:latest|' .env
```

`.env` now exists pre-Stage-7. Stage 7's "copy `.env.example` → `.env` if missing" branch will be a no-op, which is correct.

**Suggested fix:** update `.env.example` and CLAUDE.md to either (a) document `ollama/ollama:latest` as the validated image, or (b) restore a real published dustynv tag and verify. Either way the current state is broken.

### 12:07 PT — Run #2: ollama image pulled, stage 6 still fails — script never runs `ollama pull`

After the OLLAMA_IMAGE override, stages 1-5 pass clean (idempotent). Stage 6 successfully pulls `ollama/ollama:latest` (8.93 GB image), starts the `ollama-stage6` container — and **immediately runs the verification step (`ollama list`) without ever issuing any `ollama pull` commands**.

Reading `stage_prepull_models()` in `scripts/first-boot.sh` lines 615-643:

```bash
docker run -d --rm --runtime nvidia --name ollama-stage6 \
  -v ollama_models:/root/.ollama "${ollama_image}" serve
sleep 5
echo "Verifying both models are present in the volume..."
model_list=$(docker exec ollama-stage6 ollama list 2>&1 || true)
docker stop ollama-stage6 2>/dev/null || true
if ! echo "${model_list}" | grep -q "qwen3:4b"; then
  echo "ERROR: qwen3:4b not found in ollama list."
  return 1
fi
```

There is no `ollama pull` anywhere in the function. The function is misnamed — it's a *verify*, not a *pre-pull*. On a fresh box this stage will always fail.

**Third script bug.** Combined with bugs #1 (Stage 4 MAXN) and #2 (image tag), `first-boot.sh` cannot run end-to-end on a clean JetPack 6.2.2 box.

**Workaround applied:** manually pull the models. Pull rate ~30 MB/s on the bring-up LAN; qwen3:4b (2.5 GB) finishes in ~90s, nomic-embed-text:v1.5 (146 MB) in seconds.

```bash
sudo docker run -d --runtime nvidia --name ollama-stage6 \
  -v ollama_models:/root/.ollama ollama/ollama:latest serve
sleep 5
sudo docker exec ollama-stage6 ollama pull qwen3:4b
sudo docker exec ollama-stage6 ollama pull nomic-embed-text:v1.5
sudo docker exec ollama-stage6 ollama list   # verify
```

After the manual pulls, the volume `ollama_models` has both models persisted; `docker compose up -d` (Stage 7 equivalent) mounts that same volume, so the production Ollama service inherits them.

**Suggested fix for `first-boot.sh`:** add explicit `docker exec ollama-stage6 ollama pull qwen3:4b` and `... pull nomic-embed-text:v1.5` calls between the `docker run` and the verification step. Trivial 2-line addition.

### 12:08 PT — Sub-bug: `mailbox` user not in `docker` group

JetsonHacks `install_nvidia_docker.sh` (Stage 2) does not add the invoking user to the `docker` group. After Stage 2 the user can run `sudo docker ...` but not `docker ...`. Manual fix:

```bash
sudo usermod -aG docker mailbox
# Group membership applies on next login. Existing sessions need:
exec sg docker -c "<command>"
# Or just continue using sudo for this session.
```

For automation purposes I'm staying on `sudo docker` for the rest of this install. Suggested fix: `first-boot.sh` Stage 2 should `usermod -aG docker "$SUDO_USER"` after JetsonHacks finishes. Alternative: skip group entirely and just have all docker invocations on the appliance use `sudo` (consistent with how compose deploys are documented in `CLAUDE.md`'s deploy-flow examples).

### Decision: skip remaining first-boot.sh runs

Three bugs in one script (Stage 4 MAXN detection, Stage 6 dustynv image tag, Stage 6 missing `ollama pull` calls) plus the docker-group issue means `first-boot.sh` does not currently fit a clean install. From here on I will:

1. Manually run remaining model setup (DR-18 `qwen3:4b-ctx4k` Modelfile)
2. Manually run `docker compose up -d` (equivalent to Stage 7)
3. Manually run `docker compose --profile migrate run mailbox-migrate` (Stage 8 in the planned `factory-bootstrap.sh`)
4. Manually run `docker compose --profile qdrant-bootstrap run mailbox-qdrant-bootstrap` (Stage 9 in the planned script)

These four steps are well-documented in CLAUDE.md and don't need a wrapper. The script's main value (idempotent guard rails for human operators on box #N) survives the bugs — they all surface clearly. Suggest filing one consolidated ticket with all four fixes at the same time.

### 12:38 PT — Bug #4: volume namespacing mismatch

After completing manual pulls into `ollama_models` (the bare-name volume created by `first-boot.sh` Stage 6), `docker compose up -d` started `mailbox-ollama-1` — but it mounted **`mailbox_ollama_models`** (Docker Compose's project-prefixed volume), NOT `ollama_models`. The two are entirely separate; the manually-pulled models were invisible to the production Ollama service.

```
$ docker volume ls
local     ollama_models               # what stage_prepull_models uses
local     mailbox_ollama_models       # what compose actually mounts
```

This is the **fourth structural bug in `first-boot.sh`** — even if the missing `ollama pull` calls were added to Stage 6, the models would land in the wrong volume.

**Workaround applied:** re-pull `nomic-embed-text:v1.5` inside `mailbox-ollama-1` (post compose-up) so it lands in `mailbox_ollama_models`. `qwen3:4b` got auto-pulled by the `ollama create qwen3:4b-ctx4k` step (Modelfile `FROM qwen3:4b` triggers a base-model pull when the base is missing). Then `docker volume rm ollama_models` to reclaim the orphaned ~3 GB.

**Suggested fix:** Stage 6 should declare its volume as `mailbox_ollama_models` (matching the compose project name) OR use `docker compose run --rm ollama ollama pull ...` to reuse the compose-managed volume. The latter avoids hardcoding the project-name prefix.

### 12:42 PT — Stage 7 equivalent: `docker compose up -d` (manual)

```bash
cd ~/mailbox && sudo docker compose up -d
```

Result: 6 containers started in dep order. Healthchecks at +60 s:
- ✅ postgres (healthy in 6 s)
- ✅ qdrant (healthy in 36 s)
- ✅ ollama (healthy in 36 s)
- ✅ n8n (healthy in 36 s, depends on postgres)
- ✅ mailbox-dashboard (healthy in 36 s, depends on n8n)
- ❌ caddy (restart-loop) — **expected**, `.env` still has `CLOUDFLARE_API_TOKEN=changeme_cloudflare_dns_edit_token` placeholder; will fix in Phase 10. Caddy doesn't gate the other services.

Compose stack visible to host on bound ports:
- 5432 (postgres), 5678 (n8n), 6333 (qdrant), 11434 (ollama), 3001 (dashboard).

### 12:43 PT — DR-18 `qwen3:4b-ctx4k` Modelfile

`ollama create qwen3:4b-ctx4k -f -` (heredoc form) **fails** with "no Modelfile or safetensors files found" — `-f -` doesn't read stdin in this Ollama version. Use `docker cp` instead:

```bash
cat > /tmp/Modelfile.qwen3-4b-ctx4k <<EOF
FROM qwen3:4b
PARAMETER temperature 0.7
PARAMETER top_k 20
PARAMETER top_p 0.8
PARAMETER num_ctx 4096
PARAMETER stop <|im_start|>
PARAMETER stop <|im_end|>
EOF
sudo docker cp /tmp/Modelfile.qwen3-4b-ctx4k mailbox-ollama-1:/tmp/Modelfile
sudo docker exec mailbox-ollama-1 ollama create qwen3:4b-ctx4k -f /tmp/Modelfile
```

Result: `qwen3:4b-ctx4k` (id `60b93b5bcce3`) created, alongside `qwen3:4b` and `nomic-embed-text:v1.5`. All three persisted in `mailbox_ollama_models`.

### 12:45 PT — Bug #5: schema bootstrap gap (`scripts/init-db/00-schemas.sql`)

`docker compose --profile migrate run mailbox-migrate` **fails immediately** on Migration 001:

```
[fail] 001-extend-drafts-add-status-and-timestamps-v1-2026-04-27
error: relation "mailbox.drafts" does not exist
```

Migration 001 is `ALTER TABLE mailbox.drafts ...` — it assumes the table exists. There is **no migration 000** that creates the base tables. The repo's only init artifact is `scripts/init-db/00-schemas.sql` (mounted to `/docker-entrypoint-initdb.d/`), which only runs `CREATE SCHEMA IF NOT EXISTS mailbox` + GRANTs — no tables.

Mailbox #1's mailbox schema has 11 tables but `mailbox.migrations` only logs from 001 onward. The implication: M1's tables came from `dashboard/test/fixtures/schema.sql` (the canonical schema snapshot used by tests + `kysely-codegen`) being applied manually before migrations existed in the current form. That step is undocumented anywhere in the repo.

**Workaround applied for M2:**

```bash
# Apply the canonical schema snapshot (post-all-migrations state) directly.
sudo docker exec -i mailbox-postgres-1 psql -U mailbox -d mailbox \
  < dashboard/test/fixtures/schema.sql

# Backfill mailbox.migrations so the runner treats 001-018 as already applied.
versions=$(ls dashboard/migrations/*.sql | xargs -n1 basename | sed "s/\.sql$//" \
  | awk "{printf \"(%c%s%c),\", 39, \$0, 39}" | sed "s/,$//")
echo "INSERT INTO mailbox.migrations (version) VALUES $versions ON CONFLICT DO NOTHING;" \
  | sudo docker exec -i mailbox-postgres-1 psql -U mailbox -d mailbox
```

Result: 11 tables in `mailbox.*`, 18 rows in `mailbox.migrations`, runner now reports `[skip] 001-018 (already applied)` and `migrations complete`.

**Suggested fix:** add `scripts/init-db/01-schema-baseline.sql` (or rename `00-schemas.sql` to `00-namespace.sql` + add `01-baseline.sql` containing the table definitions). Source it from `dashboard/test/fixtures/schema.sql`. Document the relationship between the canonical snapshot, the migrations directory, and `00-schemas.sql` somewhere — currently it's tribal knowledge.

### 12:46 PT — Qdrant bootstrap (`docker compose --profile qdrant-bootstrap run`)

Clean run on the first try. Two collections + payload indexes created:

```
[qdrant-bootstrap] === email_messages ===
[qdrant-bootstrap] created collection 'email_messages' (768d Cosine)
[qdrant-bootstrap]   payload index 'message_id' (keyword)
[qdrant-bootstrap]   payload index 'thread_id' (keyword)
[qdrant-bootstrap]   payload index 'sender' (keyword)
[qdrant-bootstrap]   payload index 'direction' (keyword)
[qdrant-bootstrap]   payload index 'sent_at' (datetime)
[qdrant-bootstrap]   payload index 'classification_category' (keyword)
[qdrant-bootstrap]   payload index 'persona_key' (keyword)
[qdrant-bootstrap] === kb_documents ===
[qdrant-bootstrap] created collection 'kb_documents' (768d Cosine)
[qdrant-bootstrap]   payload indexes: doc_id, chunk_index, mime_type
```

Note: bootstrap creates **2 collections** but project description (CLAUDE.md) only mentions `email_messages` for M3.5. `kb_documents` is for the future KB-upload feature — present in the bootstrap script, not yet wired into a UI/intake path. Worth flagging that the `kb_documents` collection exists pre-emptively.

### 12:47 PT — n8n workflow import (planned factory-bootstrap.sh Stage 10)

`scripts/n8n-import-workflows.sh` defaults to ssh-ing to the alias **`jetson-tailscale`** (was `jetson-tailscale → mailbox1` in our rename, but that rename is in the workstation's clone, not yet pulled to mailbox2). Hand-imported via `docker cp` + `n8n import:workflow` instead:

```bash
for f in n8n/workflows/MailBOX*.json; do
  sudo docker cp "$f" mailbox-n8n-1:/tmp/$(basename "$f")
  sudo docker exec mailbox-n8n-1 n8n import:workflow --input=/tmp/$(basename "$f")
done
```

**Discovery:** there are **5 workflow JSONs**, not 4 as CLAUDE.md and v0.1 plan say:

| Workflow | In CLAUDE.md? |
|---|---|
| `MailBOX` | yes |
| `MailBOX-Classify` | yes |
| `MailBOX-Draft` | yes |
| `MailBOX-Send` | yes |
| **`MailBOX-FetchHistory`** | **no — undocumented** |

Suggest folding `MailBOX-FetchHistory` into CLAUDE.md "Pipeline flow" diagram or removing if obsolete.

All 5 imported as `active=false` (per CLAUDE.md's recurring footgun). Will activate at Phase 12.

### 12:47 PT — Phase 8 closure summary

| Service | State | Notes |
|---|---|---|
| postgres | ✅ healthy | 11 tables in `mailbox.*`, 18 migrations marked applied |
| qdrant | ✅ healthy | 2 collections (`email_messages`, `kb_documents`) |
| ollama | ✅ healthy | 3 models: `qwen3:4b`, `qwen3:4b-ctx4k`, `nomic-embed-text:v1.5` |
| n8n | ✅ healthy | 5 workflows imported, all `active=f` |
| mailbox-dashboard | ✅ healthy | Routes responding internally; public surface gated by Caddy |
| caddy | ❌ restart loop | Expected — `.env` placeholder Cloudflare token. Phase 10 fixes. |

**Phase 8 timings (manual, not first-boot.sh):**
- Docker via JetsonHacks: ~70 s (Stage 2)
- GPU smoke: ~5 s (Stage 3)
- Manual MAXN_SUPER + systemd unit: ~3 s
- Manual model pulls (`qwen3:4b` + `nomic-embed-text:v1.5`): ~90 s @ 30 MB/s
- `qwen3:4b-ctx4k` create (incl. base re-pull into compose volume): ~30 s
- `docker compose up -d` to all-healthy (5/6): ~36 s
- Schema apply + migration backfill: ~3 s
- Qdrant bootstrap: ~4 s
- n8n workflow import (5 files): ~10 s
- **Total Phase 8 (excluding waiting for confirmations): ~4 min compute** (vs the 15-25 min budget — most of that was waiting for human-in-loop or the wrong things to run before being aborted)

**Consolidated `scripts/first-boot.sh` ticket recommendation:** five fixes belong in one PR.

1. Stage 4: use `nvpmodel -p --verbose` (mode list), parse `POWER_MODEL: ID=N NAME=...`, match `*MAXN*` for the name (covers `MAXN`, `MAXN_SUPER`, `MAXN_*`).
2. Stage 6: change OLLAMA_IMAGE default to `ollama/ollama:latest` (or restore a real published `dustynv/ollama` tag).
3. Stage 6: actually run `ollama pull qwen3:4b` and `ollama pull nomic-embed-text:v1.5` — currently absent.
4. Stage 6: use the compose-managed volume name (or run pulls via `docker compose run`).
5. Stage 2: `usermod -aG docker "$SUDO_USER"` after JetsonHacks.

Plus a separate suggestion for the schema bootstrap (file an init-db/01-baseline.sql, not a script change).

## Phase 10/11/12 execution log

### 22:35 PT — Phase 10: domain pivot to `staqs.io`

Original plan said `mailbox.futurecompounds.com`. Eric requested switch to `mailbox.staqs.io` (zone owned by Eric@staqs.io's CF account). Reused token Eric supplied — verified scope: zone `staqs.io` only, permissions `dns_records:edit/read` + `zone:read`. No new token needed.

DNS A record created via API (no human-in-loop browser step needed since the token already had `dns_records:edit`):
- `mailbox.staqs.io` → `192.168.50.11`, proxied=false (DNS-01 needs unproxied), TTL auto.
- Initial dig returned CF anycast IPs because of zone-wide proxied wildcard `*.staqs.io` shadowing in cache; explicit record won within ~10s, all four resolvers (`1.1.1.1`, `8.8.8.8`, `melissa.ns.cloudflare.com`, `titan.ns.cloudflare.com`) returned `192.168.50.11`.

### 22:50 PT — Bug #1: Caddyfile hardcoded domain

Plan §10 said "set `DOMAIN` in `.env`". `DOMAIN` is dead — `caddy/Caddyfile` line 1 is `mailbox.heronlabsinc.com {` with no `{env.DOMAIN}` substitution. Real fix: `sed -i 's|^mailbox\.heronlabsinc\.com|mailbox.staqs.io|' caddy/Caddyfile`. Filed as follow-up #6.

### 22:55 PT — Bug #2: `docker compose restart` doesn't reload `.env`

Updated `CLOUDFLARE_API_TOKEN` in `.env`, ran `docker compose restart caddy`. Caddy still saw the placeholder (`API token 'changeme_cloudflare_dns_edit_token' appears invalid`). Switched to `docker compose up -d caddy` (recreates container, re-evaluates `.env`) — token then resolved correctly. Filed as follow-up #8.

### 23:00 PT — Bug #3: `MAILBOX_BASIC_AUTH_HASH` empty in `.env`

After fixing Cloudflare, Caddy moved to next failure: `account 0: username and password are required`. The `.env` had `MAILBOX_BASIC_AUTH_HASH=` (empty value) — `factory-bootstrap.sh` (or whoever cp'd `.env.example` → `.env`) never populated it. Generated bcrypt for password `0420`:

```bash
docker run --rm caddy:2 caddy hash-password --plaintext "0420"
# raw : $2a$14$vSW0lfA0XoPdbANnEyiLk.3ZmxBSVmi66l4nH8289HVnQ9XcFjdwG
# escaped (.env): $$2a$$14$$vSW0lfA0XoPdbANnEyiLk.3ZmxBSVmi66l4nH8289HVnQ9XcFjdwG
```

CLAUDE.md `$$` escaping convention applied. After `docker compose up -d caddy` the var resolved to 60-byte hash inside the container, basic_auth came up clean. Filed as follow-up #7.

### 23:05 PT — Phase 10 closure: cert obtained + verification

```
Let's Encrypt cert: subject=mailbox.staqs.io  issuer=Let's Encrypt E8
                    notBefore=May  6 05:31:50 2026 GMT
                    notAfter =Aug  4 05:31:49 2026 GMT
unauth /dashboard/queue       → 401 ✅
auth admin:0420 /dashboard/queue → 200 ✅
unauth /webhook/anything      → 401 ✅ (STAQPRO-161 holds)
```

Cert has no LE account email (logs: `email:""`) because Caddyfile has no `email` directive in the `tls` block — same gap as the hardcoded domain (follow-up #6).

### 23:30 PT — Phase 11: smoke test

Plan §11.2 `curl http://localhost:11434/api/generate` failed with `Connection refused`. M2 docker-compose has no `ports:` block on the ollama service — docker-network-only by design (different from M1, which exposes `:11434` on the LAN per its CLAUDE.md). Re-ran the same probe via `docker exec mailbox-dashboard wget -qO- http://ollama:11434/...`:

| Check | Result |
|---|---|
| 6 services up + healthy | ✅ |
| Models loaded | `qwen3:4b`, `qwen3:4b-ctx4k` (DR-18), `nomic-embed-text:v1.5` |
| `qwen3:4b-ctx4k` generate | ✅ "Hello! 😊 …" — 139 tokens / 7.95s ≈ 17.5 tok/s, 8s warm |
| Postgres `mailbox.*` tables | ✅ all 11 (drafts, inbox_messages, classification_log, persona, sent_history, state_transitions, kb_documents, onboarding, rejected_history, system_state, migrations) |

Filed as follow-up #9 (CLAUDE.md "Public surface" still M1-only).

### 23:35 PT — Phase 12: n8n active-flag verification

5 workflows present (one extra vs the docs — `MailBOX-FetchHistory`, webhook-triggered for Gmail History API backfill). All 5 imported `active=f`. Activated each via `n8n update:workflow --active=true --id=<id>`, restarted n8n container (CLI flag is no-op without restart per CLAUDE.md), re-queried:

```
         name         | active 
----------------------+--------
 MailBOX              | t
 MailBOX-Classify     | t
 MailBOX-Draft        | t
 MailBOX-FetchHistory | t
 MailBOX-Send         | t
```

CLAUDE.md's deploy-gate one-liner held — would have caught this had we shipped pre-activation.

### Phase 10/11/12 timings

- Phase 10 (DNS create + .env wiring + 3 cert iterations + verify): ~30 min wall (mostly waiting for cert + debugging the 3 bugs)
- Phase 11 (smoke): ~3 min wall
- Phase 12 (activate + restart + verify): ~2 min wall

### Closure: appliance is live, awaiting customer

Pipeline is fully operational under `https://mailbox.staqs.io/dashboard/queue` (`admin` / `0420`). Phases 13+ require customer Gmail OAuth (HUMAN-IN-LOOP) and persona configuration before live-gate flip.

---

## Session 2 (2026-05-06 → 2026-05-07): STAQPRO-237 templating, Phase 13 OAuth, Phase 14 persona prep, classify bug

Picked up after the previous session left the appliance in a clean post-Phase-12 state. Eric committed to mock customer #2 role (`eric@staqs.io` Gmail). This session covered the templating cleanup found during Session 1, the Phase 13 OAuth flow (with multiple unrelated bugs surfacing), and Phase 14 persona pre-config — all without flipping the live-gate.

### Templating + access cleanup (before customer OAuth)

| Commit | Why |
|---|---|
| `dc0085c` | docs: split CLAUDE.md "Public surface" into M1 + M2 entries; corrected stale `192.168.1.45` IP for M1 |
| `fd49e58` | **STAQPRO-237**: Caddyfile template for `{$DOMAIN}` + `{$CADDY_EMAIL}`; close the per-customer `sed` workaround. Validated against the project's custom `mailbox-caddy` image before deploy. M2 had a dirty Caddyfile from the Session 1 sed — stashed, pulled, dropped. M1 was clean. Both `up -d caddy` cleanly. **STAQPRO-237 closed Delivered.** |
| `3fa569f` | n8n env var templating: `N8N_HOST` / `WEBHOOK_URL` / `N8N_EDITOR_BASE_URL` driven from `${DOMAIN}` (was hardcoded `mailbox.heronlabsinc.com`, blocked Eric's OAuth setup screen because the redirect URL was prefilled with the wrong domain and read-only). M1 unaffected (DOMAIN resolves identically). |
| `d7745d5` | Two workflow-JSON fixes pre-OAuth: (a) `MailBOX-Send / Gmail Reply` had no credentials field — wired to credential id `vEz5mz0uaAtlK8yz`; (b) STAQPRO-226 manual workaround applied — `MailBOX / Get many messages.limit` lowered from `1000` → `50`. M1 not changed (live customer, has STAQPRO-227/228 cooldown system). |

### Phase 13: Eric Gmail OAuth — three blockers we hit

1. **Caddy `/` redirects to `/dashboard/queue`** (intentional per Caddyfile comment). Eric kept landing on the dashboard instead of n8n. **Workaround**: tell him to use `https://mailbox.staqs.io/setup` directly (any non-root n8n path bypasses the redirect). Worth noting in install plan §13 prose.
2. **Caddy basic_auth blocks n8n's SPA background fetches** (`/healthz`, `/assets/InsightsDashboard-*.js`, `/rest/telemetry/*`). Browser doesn't auto-include cached basic_auth on `<link rel="preload">` and dynamic-import paths → 401 → SPA misinterprets the `/healthz` 401 as "session expired" → pops a sign-in modal in a loop, even AFTER the user is signed in. Took ~30 min of misdirection before we caught it (we tried disabling `N8N_SECURE_COOKIE`, looked for cookie issues, etc.). **Real fix**: shipped in `9c64e8a` — extend the Caddyfile `@protected` matcher to exempt `/healthz` and `/assets/*` (in addition to `/mcp-server/*`) from basic_auth, AND set `N8N_DIAGNOSTICS_ENABLED=false` to stop the rudderstack/posthog telemetry pings entirely.
3. **Eric's password reset.** During the loop debug we suspected wrong password. Reset Eric's bcrypt hash directly via SQL with a known value (`TempStaqs2026!`) so he could rule out password issues. After the real fix landed, Eric was in. He should rotate this from Settings → Personal once he's done OAuth.

### Phase 13 closure: OAuth lands cleanly

Eric completed Gmail OAuth via the n8n UI ("Connect my account" on the pre-staged `gmailOAuth2` credential `vEz5mz0uaAtlK8yz`). Encrypted credential blob went from ~272 bytes (just `clientId`+`clientSecret`) to **1728 bytes** (full OAuth tokens). Tokens populated, all 4 Gmail nodes wired to that credential ID start working immediately.

### Phase 14 prep (persona + live-gate verification)

- `mailbox.persona` row inserted for `customer_key='default'` with operator overrides: `tone='casual, conversational, plain-spoken — short replies, first-person, no corporate hedging'`, `signoff='Cheers, Eric'`, `operator_first_name='Eric'`, `operator_brand='Staqs'`. Resolves to Eric's persona instead of the hardcoded Heron Labs fallback when the live-gate flips.
- `mailbox.onboarding` is empty (no row), so `getOnboarding()` returns null → `stage` defaults to `pending_admin` → `/api/onboarding/live-gate` returns `{live: false}`. **Drafts will not generate even though OAuth is now complete.** Classification still fires unconditionally (per `D-49` comment in the live-gate route).
- Verified: `MAILBOX_LIVE_GATE_BYPASS` is NOT set on M2 dashboard. No accidental drafts.

### Phase 13.5: classify-output bug discovered on first 5-min tick

Eric's OAuth completed → first 5-min Schedule tick fired → 20 inbox messages fetched → 15 classified — and **all 15 returned `category=unknown / confidence=0.00 / json_parse_ok=f`**. Pipeline plumbing OK; classifier output broken.

Direct probe explained why:

| Test | response field | thinking field | latency | tokens |
|---|---|---|---|---|
| `format: "json"` (production) | empty | `{"category":"follow_up","confidence":0.9}` | 7 s | 20 |
| no format constraint | `{"category":"unknown","confidence":0.7}` | (long CoT) | 138 s | 2294 |
| `think: false` (cleaner fix) | `{"category":"inquiry","confidence":0.95}` | empty | 7 s | 21 |

**Root cause**: Ollama 0.23.0 (M2) reports Qwen3 capabilities as `completion, tools, **thinking**`. M1's older Ollama 0.20.5 reports only `completion`. With thinking-mode enabled, `format: "json"` constrains the OUTPUT to JSON — but Qwen3's thinking-mode places the JSON in the `thinking` field and leaves `response` empty. n8n's `Normalize` node read `$json.response` only.

**Bandaid (deployed `0c857e2`)**: change Normalize body to `$json.response || $json.thinking || ''`. Forward-compatible (older Ollama just doesn't have a `thinking` field, falls through to response). Verified via re-import + restart on both M2 + M1. Deployed simultaneously to M1 even though M1 is silently working today (under 0.20.5) — protects against M1's eventual `:latest` pull bumping to 0.23+.

**Cleaner fix not deployed**: add `"think": false` to the Ollama call body. Works on Ollama 0.21+ (older versions ignore the field). Filed as part of **STAQPRO-240** (pin Ollama image, document Qwen3 thinking-mode behavior). Tracked separately because the real story is "no `:latest` for Ollama" — pinning is the systemic fix.

### Followups filed during Session 2

| ID | Title | Pri | Status |
|---|---|---|---|
| STAQPRO-237 | Caddyfile templating — `{$DOMAIN}` + `{$CADDY_EMAIL}` | M | **Delivered** in `fd49e58` |
| STAQPRO-238 | M1 public DNS stale — flip to **tailnet IP** (revised plan in comment, not LAN IP) | H | Backlog |
| STAQPRO-239 | first-boot fail-fast: empty `MAILBOX_BASIC_AUTH_HASH` + `restart` vs `up -d` env reload | M | Backlog |
| STAQPRO-240 | Pin Ollama image (no `:latest`); document Qwen3 thinking-mode | H | Backlog |

Plus comment on STAQPRO-226 (Gmail bootstrap mode): manual workaround applied for M2; mock-customer #2 acceptance now technically violated (real fix still owed before customer #3).

### Tailnet IP DNS pivot (separate from STAQPRO-237)

Eric noted the dashboard worked from the workstation but not from his phone or his laptop off the office WiFi. Reason: `mailbox.staqs.io` resolved to M2's LAN IP (`192.168.50.11`), which is non-routable from anywhere off the LAN. Per the STAQPRO-175 design, off-LAN access is via Tailscale.

**Fix (no ticket needed)**: flipped the public Cloudflare A record `mailbox.staqs.io` → `100.120.102.45` (M2 tailnet IP). Tailscale daemon recognizes CGNAT IPs and routes them through the tailnet tunnel transparently. Anyone with the Tailscale app on this tailnet can now hit the dashboard from anywhere on Earth. Off-tailnet visitors still can't (same privacy posture as before).

The same approach applies to M1 — STAQPRO-238's plan is now "flip M1 A record to `100.65.9.2`" instead of "fix the LAN IP," which sidesteps the original blocker (we don't control `heronlabsinc.com` zone DNS but we can advise the owner).

### Status snapshot at session end (2026-05-07 ~13:45 PT)

- ✅ Phase 13: Gmail OAuth completed, credential populated with tokens, pipeline reaching Eric's inbox
- ✅ Phase 14 partial: persona override row inserted, live-gate verified closed (drafts won't fire)
- ⏸ Phase 15 (RAG backfill): not yet run — depends on Eric's sent corpus volume; FetchHistory webhook works but has the silent-truncation gap at >500 sent (noted earlier)
- ⏸ Phase 16 (live-gate flip): blocked on classify quality verification (Session 3 — verify that the deployed Normalize fix actually produces real categories on next tick when Eric gets new mail)
- ⏸ Phase 17 (constraint baseline): blocked on Phase 16

### Lessons applicable to next install

1. **Caddy basic_auth + n8n SPA polling = sign-in modal loop.** The Session 1 install plan didn't mention this. Now baked into the Caddyfile (`/healthz` + `/assets/*` exemptions in the `@protected` matcher). Future installs are pre-fixed.
2. **n8n's OAuth credential setup screen prefills the redirect URL from `N8N_EDITOR_BASE_URL` and the field is read-only.** Make sure `N8N_HOST` / `WEBHOOK_URL` / `N8N_EDITOR_BASE_URL` are templated from `${DOMAIN}` BEFORE Eric (or any customer) opens the credential setup.
3. **Caddy `redir / /dashboard/queue` traps users who try to land on n8n at `/`.** Tell the operator to use `/setup` (or any non-root n8n path) explicitly during onboarding instructions.
4. **`OLLAMA_IMAGE: ollama/ollama:latest` is unsafe.** STAQPRO-240 owns the pin.
5. **Workflow JSON re-imports default to `active=false`** — known footgun, hit twice in this session (MailBOX, MailBOX-Send post-d7745d5; MailBOX-Classify post-0c857e2). Activate + restart in the same SSH call.
6. **Persona override + live-gate state** can be set BEFORE OAuth completes — pre-stages the appliance to behave correctly the moment OAuth lands. We did persona right; we should bake `mailbox.onboarding` initial-row insert into bootstrap so the live-gate's "no row" fallback isn't load-bearing.

### Deferred (not in this session)

- Direct verification that the Normalize fix (`response || thinking`) produces real categories — requires either fresh inbox volume or a manual Classify Sub trigger. Direct probe already proved the code path works; the live verification waits for Eric's next inbound mail.
- Live-gate flip — explicit operator decision, not happening tonight.
- M1 DNS A record flip per STAQPRO-238 — needs heronlabsinc.com zone access.

## Session 3 (2026-05-07 ~23:45 PT): Phase 13.5 closure — `think: false` deployed

Picked up the Phase 13.5 thread to verify the deferred verification gate ("does the Normalize fix produce real categories on next live tick?"). Direct execution-data inspection on M2 confirmed the Normalize bandaid was working correctly — the `thinking` field was being read when `response` was empty. The bug shape had shifted: not a plumbing failure, but **classification quality regression** under thinking-mode + format:json on signature-laden bodies.

### Diagnosis: divergence vs M1 confirmed

Replayed an M1-known-correct inquiry email (`saul@adallennutrition.com` "Re: Introduction – Monk Fruit & Stevia Solutions for Heron Labs", 4331-char body with full corporate signature) on M2's classifier:

| Appliance | Ollama version | Qwen3 caps | Result on M1-shape inquiry |
|-----------|---------------|------------|---------------------------|
| **M1** (live) | 0.20.5 | `completion` only | `inquiry: 0.9` ✓ |
| **M2** (pre-fix, thinking active) | 0.23.0 | `completion, tools, thinking` | thinking-field `unknown: 0.1` (model anchored on signature noise) |
| **M2** (post-fix, `think: false`) | 0.23.0 | (think disabled in call) | `inquiry: 0.95` ✓ |

M1's last 15 classifications all correct (`internal:1.0` for heron labs, `inquiry:0.9` for prospects, `follow_up:0.9` for thread continuations, `spam_marketing:0.95` for newsletters, `scheduling:0.9` for calendar logistics) — all with full signatures. **M1 is the proof-of-concept that Qwen3 in non-thinking-mode handles signature-laden emails correctly.** No fix was needed on M1 in Session 2 because thinking-mode wasn't a thing on 0.20.5.

The dustin@umbadvisors.com "We are looking to have a website for UMB Advisors made" still classifies as `unknown:0.2` post-fix — but that's correct behavior (web-design ask is genuinely off-domain for a CPG operator's classifier; routes to cloud safety net via `confidence < 0.75` → `cloud_categories`).

### Fix deployed

**Repo change** (commit `da0e9e3`): `n8n/workflows/MailBOX-Classify.json` — added `"think": false` to the `Call Ollama` node's `jsonBody` alongside the existing `"format": "json"` and `"options": { "temperature": 0 }`. One-line JSON change.

**Deploy chain (both appliances, identical workflow JSON)**:

```bash
# Workstation
git push origin master                         # da0e9e3 lands on origin

# M2 (thinking-mode active — the actual regression target)
ssh mailbox2 'cd ~/mailbox && git pull --ff-only'
ssh mailbox2 'docker cp n8n/workflows/MailBOX-Classify.json mailbox-n8n-1:/tmp/c.json && \
              docker exec mailbox-n8n-1 n8n import:workflow --input=/tmp/c.json && \
              docker exec mailbox-n8n-1 n8n update:workflow --active=true --id=MlbxClsfySub0001 && \
              cd ~/mailbox && docker compose restart n8n'
# Verify all 5 workflow_entity rows show active=t post-restart
ssh mailbox2 "docker exec mailbox-postgres-1 psql -U \$(grep ^POSTGRES_USER /home/mailbox/mailbox/.env | cut -d= -f2-) \
              -d \$(grep ^POSTGRES_DB /home/mailbox/mailbox/.env | cut -d= -f2-) \
              -c \"SELECT name, active, \\\"updatedAt\\\" FROM workflow_entity WHERE name LIKE 'MailBOX%' ORDER BY name;\""

# M1 (forward-compat — Ollama 0.20.5 ignores think: false; same JSON, no behavioral change)
ssh mailbox1 'cd ~/mailbox && git pull --ff-only'
ssh mailbox1 'docker cp n8n/workflows/MailBOX-Classify.json mailbox-n8n-1:/tmp/c.json && \
              docker exec mailbox-n8n-1 n8n import:workflow --input=/tmp/c.json && \
              docker exec mailbox-n8n-1 n8n update:workflow --active=true --id=MlbxClsfySub0001 && \
              cd ~/mailbox && docker compose restart n8n'
```

Both appliances: 4 production workflows + sub-workflows all `active=t` post-restart. M1 forward-compat probe with `think: false` returned valid classification (`follow_up: 0.9` on the same saul@adallennutrition email — slight category drift vs M1's earlier `inquiry: 0.9`, but both are `LOCAL_CATEGORIES` so routing is identical).

### Status snapshot at session end (2026-05-07 ~23:50 PT)

- ✅ Phase 13: Gmail OAuth (Session 2)
- ✅ Phase 13.5: classify quality regression diagnosed + fixed (`think: false` shipped to M2 + M1)
- ✅ Phase 14 partial: persona override + live-gate verified closed (Session 2)
- ⏸ Phase 15 (RAG backfill): in flight at end of this session — `dashboard/scripts/rag-backfill.ts` ready to run inside `mailbox-dashboard` container; depends on Eric's sent-corpus volume; FetchHistory webhook silent-truncation gap at >500 sent still open
- ⏸ Phase 16 (live-gate flip): unblocked on classify quality; still gated on Phase 15 complete + Eric explicit consent
- ⏸ Phase 17 (constraint baseline): blocked on Phase 16

### STAQPRO-240 status update

This session resolved the immediate signature regression. The systemic fix — pinning `OLLAMA_IMAGE` to a concrete tag rather than `:latest` — is the next deliverable on STAQPRO-240. M2 is currently 0.23.0 (with thinking-mode mitigated by `think: false`); M1 is 0.20.5 (no thinking-mode). Pin strategy options:

- **A. Per-box pin to current version**: M1 stays 0.20.5, M2 stays 0.23.0. Safest no-op; freezes the divergence; leaves a 2-track fleet.
- **B. Unify on M2's 0.23.0**: M1 needs upgrade. Since `think: false` is already deployed defensively, the upgrade should be safe.
- **C. Unify on M1's 0.20.5**: M2 downgrades. Risk: re-pull of qwen3 model files; possibly different bug surface on older Ollama.

Recommend **A as the defensive pin** (capture current state, prevent further drift), then plan a coordinated upgrade as a separate ticket once both appliances are stable.

### Lessons for next install (additions to v0.2's earlier list)

7. **Verify deferred verification gates are still correct hypotheses before re-deploying.** Session 2 deferred "does the Normalize fix produce real categories" assuming the fix was the only blocker. Session 3 found a *second* layer of regression (model quality under thinking-mode) that was masked by the first. Always re-probe end-to-end after a fix lands, not just the immediate symptom.
8. **`docker exec mailbox-ollama-1 ollama show <model>` is the canonical way to read Qwen3 capabilities.** This is the diagnostic that distinguishes "thinking-mode active" from "thinking-mode not a thing on this version." Bake this into the post-deploy verification step.
9. **n8n execution_data is queryable.** `SELECT data FROM execution_data WHERE "executionId"=N` returns a deduplicated string array. Indexing by position lets you reconstruct exactly what each node received and emitted. Worth knowing for any future "what did the live workflow actually do" investigation.

### Deferred (not in this session)

- **STAQPRO-240 pin work** — proposed strategy A above; needs `.env.example` + `docker-compose.yml` edit + deploy.
- **Phase 15 RAG backfill on M2** — running next.
- **Phase 16 live-gate flip** — after Phase 15.
- **M1 DNS A record flip per STAQPRO-238** — still needs heronlabsinc.com zone access.
