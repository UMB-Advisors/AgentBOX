# MailBox One OTA Update Runbook v0.2.0

**Status:** DRAFT — authored for MBOX-181 (M5 "OTA + QA validation"). The build/push and customer-pull procedures are canonical; the rollback drill and the boot/power numbers want one real on-device pass to fill the `RESULT:` blanks before v1.0.0.

**v0.2.0 (MBOX-181 follow-up):** §6 Gate 3 description corrected — `smoke-pipeline.sh` now drives the dashboard internal routes + LLM proxy directly rather than triggering `MailBOX-Classify` via the n8n CLI. The old `n8n execute --id=<classify-sub> --file=<input>` trigger could never work on n8n 2.14.2 (`--file` is deprecated and the classify sub's `passthrough` trigger takes no input data). The route-driven mechanism replicates the classify→draft pipeline node-for-node and was validated green on M1.

**Audience:** Operator (Dustin or successor) cutting an OTA release for the custom services, and the runbook the customer-initiated update flow is derived from.

**Tracks:** MBOX-181 (this work). Related: MBOX-184 (OTA via GHCR / NFR-6), MBOX-156 (factory-bootstrap — clean-state baseline for cold-boot measurement), MBOX-157 (golden-image batch pipeline).

**Scope:** Only the two CUSTOM-built services ship via GHCR — `mailbox-dashboard` (Next.js 14, built from `dashboard/Dockerfile`) and `mailbox-caddy` (built from `caddy/Dockerfile`, xcaddy + cloudflare DNS plugin). The other six services are upstream images pinned by tag/digest in `docker-compose.yml` / `.env` (`postgres:17-alpine`, `qdrant/qdrant:v1.17.1`, `ollama/ollama@sha256:…`, `n8nio/n8n:2.14.2`, plus the `local/llama-cpp` image which is built on-device per the llama.cpp migration runbook — NOT via this OTA path).

---

## How to use this doc

- §1–§2: one-time setup (GHCR auth, buildx builder).
- §3: cut a release (build + push multi-arch, capture digests).
- §4: customer-initiated update flow (no SSH needed).
- §5: rollback by pinned digest.
- §6: post-update verification gates (the non-negotiable part).
- §7: constraint validation (boot <3 min, power <25 W) — methodology + where the numbers live.
- Bump file version on revision: patch for typos, minor for added sections, major for structural rewrite.
- `RESULT:` markers are measurement capture points — fill on the first real pass.

---

## 0. Constraints this runbook defends (root CLAUDE.md)

| Constraint | Target | Validated by |
|---|---|---|
| Updates | OTA via GHCR, **customer-initiated only** | §4 |
| Cold boot to operational | < 3 min (180 s) | §7.1 (`scripts/validate-boot-power.sh --boot`) |
| Sustained power | < 25 W under normal operation | §7.2 (`scripts/validate-boot-power.sh --power`) |
| Inbound email → draft | < 30 s local / < 60 s cloud | `scripts/smoke-pipeline.sh` (latency surfaced in the wait loop) |
| Image pinning | never `:latest` in production | §3 (push by tag AND record the digest) |

---

## 1. GHCR authentication (one-time, on the build host)

Build host is the workstation (x86_64) using `buildx` cross-build for `linux/arm64`, OR a Jetson building natively. GHCR is `ghcr.io`; images are namespaced to the org/owner.

```bash
# A GitHub PAT (classic) with write:packages scope, or a fine-grained token
# with "Packages: read and write". Store in 1Password (MailBOX vault), NOT in
# the repo. Export for this shell only:
export GHCR_PAT='<token>'
echo "$GHCR_PAT" | docker login ghcr.io -u <github-username> --password-stdin
```

Image references used below (adjust `OWNER` to the GHCR namespace, e.g. `umb-advisors`):

```
ghcr.io/OWNER/mailbox-dashboard:<tag>
ghcr.io/OWNER/mailbox-caddy:<tag>
```

Tag convention: a release tag is the short git SHA of the commit being shipped (`git rev-parse --short HEAD`), optionally also moved to a human tag like `m5` or `v0.5.0`. **Never deploy a customer to `:latest`** — see §3/§5; the customer's `.env` pins a digest.

---

## 2. Create the buildx builder (one-time, x86_64 build host)

Cross-building ARM64 from x86_64 needs QEMU + a buildx builder.

```bash
docker run --privileged --rm tonistiigi/binfmt --install arm64   # register qemu-aarch64
docker buildx create --name mailbox-builder --use
docker buildx inspect --bootstrap
```

A Jetson build host (native ARM64) skips QEMU and can build with `--platform linux/arm64` directly (slower; only if no x86_64 host is available).

---

## 3. Cut a release — build + push multi-arch, capture digests

The appliance is ARM64-only, so we build a single-arch (`linux/arm64`) image and push it. (The "multi-arch" requirement in MBOX-181 is satisfied by building under buildx with an explicit `--platform`; if an amd64 board/fleet target is ever added, extend `--platform` to `linux/amd64,linux/arm64`.)

```bash
SHA=$(git rev-parse --short HEAD)
OWNER=umb-advisors   # GHCR namespace

# --- mailbox-dashboard (build context = ./dashboard) ---
docker buildx build \
  --platform linux/arm64 \
  --tag ghcr.io/$OWNER/mailbox-dashboard:$SHA \
  --tag ghcr.io/$OWNER/mailbox-dashboard:m5 \
  --push \
  ./dashboard

# --- mailbox-caddy (build context = ./caddy) ---
docker buildx build \
  --platform linux/arm64 \
  --tag ghcr.io/$OWNER/mailbox-caddy:$SHA \
  --tag ghcr.io/$OWNER/mailbox-caddy:m5 \
  --push \
  ./caddy
```

**Capture the pushed digests** — these are what the customer pins for safe rollback:

```bash
docker buildx imagetools inspect ghcr.io/$OWNER/mailbox-dashboard:$SHA \
  --format '{{.Manifest.Digest}}'
docker buildx imagetools inspect ghcr.io/$OWNER/mailbox-caddy:$SHA \
  --format '{{.Manifest.Digest}}'
# → record both sha256:… digests in the release note + 1Password.
```

> `RESULT:` first real push — record dashboard digest + caddy digest + tag here.

### 3.1 CI (push tagged images on `master` merge)

The repo CI (`.github/workflows/`) currently runs `dashboard (typecheck + test)`. The OTA push job is a SEPARATE workflow gated on `push: branches: [master]` that:

1. logs into GHCR with `${{ secrets.GITHUB_TOKEN }}` (has `packages: write` when the workflow declares `permissions: packages: write`),
2. `docker/setup-qemu-action` + `docker/setup-buildx-action`,
3. `docker/build-push-action` for each of `./dashboard` and `./caddy` with `platforms: linux/arm64`, tags `:${{ github.sha }}` and a moving channel tag (`:edge`),
4. emits the digests to the job summary.

Customers are NEVER auto-updated by CI — CI only publishes. The pull is customer-initiated (§4). This preserves the "customer-initiated only" constraint.

> `OPEN Q:` confirm GHCR namespace (`umb-advisors` vs per-customer) and whether the package is public (free) or private (needs the customer appliance to `docker login` GHCR with a read-only token baked at provision time). Public-image is the CLAUDE.md assumption ("ghcr.io free for public images").

---

## 4. Customer-initiated update flow (no SSH)

The customer triggers an update from the appliance itself. Two surfaces, same underlying command:

1. **Operator one-liner** (the canonical flow — also what a future dashboard "Update" button shells out to):

```bash
cd ~/mailbox && git pull && docker compose pull && docker compose up -d --remove-orphans
```

- `git pull` brings the updated `docker-compose.yml` / `.env.example` / scripts.
- `docker compose pull` fetches the new images for services whose image ref changed (the GHCR-pinned dashboard + caddy if you point them at GHCR — see note).
- `docker compose up -d --remove-orphans` recreates only the changed containers. **Always pass `--remove-orphans`** (root CLAUDE.md) so a removed service doesn't leave a port-holding orphan.

> NOTE — image source seam: today `docker-compose.yml` builds `mailbox-dashboard` and `mailbox-caddy` locally (`build:` blocks). To consume GHCR images instead (true OTA, no on-device build), the customer compose pins:
> ```yaml
> mailbox-dashboard:
>   image: ghcr.io/OWNER/mailbox-dashboard@sha256:<digest>   # pinned, never :latest
> mailbox-caddy:
>   image: ghcr.io/OWNER/mailbox-caddy@sha256:<digest>
> ```
> with the `build:` block removed (or kept behind a `--profile build` for dev). This is the seam MBOX-184 lands; until then `docker compose build` on-device is the fallback (slower, needs the source tree). Either way `up -d --remove-orphans` is the apply step.

2. **`.env`-driven pin (recommended for fielded appliances):** add `DASHBOARD_IMAGE` / `CADDY_IMAGE` vars to `.env` (mirroring the existing `OLLAMA_IMAGE=…@sha256:…` pattern) and reference them as `image: ${DASHBOARD_IMAGE}` in compose. Updating = edit the digest in `.env`, then `docker compose up -d` (NOT `restart` — `restart` reuses baked-in env; see root CLAUDE.md ".env rotation gotchas").

After ANY update, run the §6 verification gates.

---

## 5. Rollback by pinned digest

Rollback is "re-pin the previous digest and re-apply". Because §3 recorded the prior digest, this is deterministic — no rebuild.

```bash
# Pre-pull the known-good previous image BEFORE stopping anything (minimize downtime).
docker pull ghcr.io/OWNER/mailbox-dashboard@sha256:<PREVIOUS_DIGEST>

# Re-pin .env (or the compose image: line) to the previous digest, then:
docker compose up -d --remove-orphans mailbox-dashboard
```

Same shape for `mailbox-caddy`. This mirrors the upstream-image rollback already in CLAUDE.md ("Stack Patterns by Variant": `docker compose pull [service]@[previous-digest]`).

### 5.1 Rollback drill (deliberate bad release → rollback → recovery)

The acceptance criterion is "rollback tested via a deliberate bad release". Do this on a NON-customer box (or a maintenance window with the operator informed):

1. Note the current-good digests (from `.env` / §3 record).
2. Push a deliberately-broken dashboard image (e.g. a build with a syntax error in a route, or a bumped tag that fails its healthcheck).
3. Pin + `up -d` the bad image. Observe: dashboard healthcheck goes unhealthy; §6 gates fail.
4. Re-pin the previous-good digest, `docker compose up -d --remove-orphans mailbox-dashboard`.
5. Confirm §6 gates green again.

> `RESULT:` rollback drill — record bad-release symptom, time-to-detect (gate fail), time-to-recover here.

---

## 6. Post-update verification gates (non-negotiable)

Run all three after every OTA pull and after every rollback. Each exits non-zero on failure so they can chain in a script.

```bash
# Gate 1 — n8n workflows still active (n8n 2.x: all four MailBOX* must be
# active or executeWorkflow throws and the inbox dark-classifies).
docker compose --profile n8n-verify run --rm mailbox-n8n-verify

# Gate 2 — infra smoke (GPU passthrough, Qwen3 inference, embeddings, Qdrant,
# Postgres). Does NOT exercise the pipeline.
./scripts/smoke-test.sh

# Gate 3 — pipeline smoke (ingest → classify → draft, synthetic message, NO
# real email sent). This is the end-to-end proof the update didn't break the
# draft path.
./scripts/smoke-pipeline.sh --host local
```

`smoke-pipeline.sh` seeds a synthetic inbound, then **drives the dashboard internal routes + LLM proxy directly** — replicating the `MailBOX-Classify` and `MailBOX-Draft` node sequence (classification-prompt → llm/api/generate → classification-normalize → classification_log insert → live-gate → draft-stub insert → draft-prompt → {baseUrl}/api/chat → draft-finalize) — and asserts a draft lands in `mailbox.drafts` with a valid category and non-empty body. It does NOT trigger n8n: the classify sub-workflow's only trigger is a `passthrough` `executeWorkflowTrigger` that takes no input, and `n8n execute --file` is deprecated/unsupported on n8n 2.14.2, so a CLI trigger could never feed it the synthetic inbox id (this was the MBOX-181 follow-up fix). Bypassing n8n orchestration still exercises the real prompts, models, route logic, DB writes, and triggers (the `classification_log` denorm trigger + the `drafts` state machine). It NEVER approves the draft or calls the `mailbox-send` webhook, so Gmail Reply is structurally never reached — safe to run against a live customer box. It cleans up its synthetic rows on exit (use `--keep` to leave them for debugging). Exit 0 = pipeline healthy (or drafting correctly gated/dropped — see below); 1 = assertion failed; 2 = setup/precondition error (e.g. the dashboard container or LLM proxy is down).

Note: if the appliance's onboarding stage is not `live` (and `MAILBOX_LIVE_GATE_BYPASS` is unset), or the synthetic message classifies as `spam_marketing`, the script exits 0 with a clear "gated"/"dropped" message rather than failing — those are healthy classify-only outcomes where no draft is created by design. The Gate-1 `n8n-verify` profile (not this script) is what catches inactive workflows.

A green OTA = all three gates exit 0.

---

## 7. Constraint validation (boot + power)

Both require on-device tooling. Run `scripts/validate-boot-power.sh` ON the appliance (over ssh from the workstation, or directly). Document the numbers in `docs/runbook/production-validation.md` (the MBOX-181 acceptance artifact) so future hardware revisions can be re-validated against the same method.

### 7.1 Cold-boot timing (target < 3 min)

The honest acceptance number is **physical power-on → first dashboard 200**, spanning firmware → kernel → JetPack → docker daemon → all 8 compose services healthy:

```bash
# After a real physical power-cycle, as the FIRST thing post-login:
ssh mailbox1 'cd ~/mailbox && bash scripts/validate-boot-power.sh --boot --since-power-on'
# uses /proc/uptime + systemd-analyze as t0, polls the dashboard health route
# (/dashboard/api/system/status) until HTTP 200, asserts elapsed < 180s.
```

Fast regression proxy (container-stack only — UNDER-reports vs cold boot, but cheap):

```bash
ssh mailbox1 'cd ~/mailbox && sudo bash scripts/validate-boot-power.sh --boot'
# DESTRUCTIVE: docker compose down then up -d --remove-orphans, timed.
```

The clean-state baseline this measures FROM is what `factory-bootstrap.sh` (MBOX-156) produces — measure cold boot on a freshly-bootstrapped box, not one with months of accumulated state.

> `RESULT:` cold boot — record true power-on number (s) + proxy number (s) + per-service health timings here.

### 7.2 Sustained power (target < 25 W)

`tegrastats` reads the Jetson INA power rails; `VDD_IN` is total board input power. Average it over a 5-min window while the pipeline is under load:

```bash
# Drive load inline (one classify cycle) and sample for 5 min:
ssh mailbox1 'cd ~/mailbox && bash scripts/validate-boot-power.sh --power --with-smoke --duration 300'
# averages VDD_IN mW across samples, asserts avg < 25000 mW (25 W).
```

For a heavier, more realistic load, loop `smoke-pipeline.sh` in a second shell during the window instead of `--with-smoke`. The appliance must be in MAXN/Super mode (`nvpmodel`, persisted by the `set-maxn-power.service` systemd unit from `first-boot.sh`) — that is the mode the 25 W envelope is specified against.

> `RESULT:` sustained power — record avg VDD_IN (mW/W), sample count, and the load profile (idle / single-cycle / looped) here.

### 7.3 Latency (inbound → draft)

`smoke-pipeline.sh` is now synchronous (it drives each pipeline step inline rather than waiting on n8n's 5-min poll), so it surfaces per-step timing — most usefully the classify LLM proxy latency (`classify LLM → … (~Nms via proxy)`) and the `/api/chat` draft call. Because there is no async hand-off, total wall-clock seed→draft is the sum of those calls; time the whole invocation (`time ./scripts/smoke-pipeline.sh …`) for an end-to-end number. Run it once on the local route and once with `--cloud` and record both against the < 30 s local / < 60 s cloud SLA:

```bash
./scripts/smoke-pipeline.sh --host local             # local path
./scripts/smoke-pipeline.sh --host local --cloud     # cloud path (needs OLLAMA_CLOUD_API_KEY)
```

> `RESULT:` latency — record local-path and cloud-path seed→draft seconds here.

---

## 8. Open questions / follow-ups

- `OPEN Q:` GHCR namespace + public vs private package (affects §1/§3.1; public is the CLAUDE.md assumption).
- `OPEN Q:` whether the dashboard exposes a customer-facing "Update" button (§4 surface 1) in M5 or whether the SSH/ttyd-free path is the operator one-liner only. ttyd was removed (STAQPRO-126); a button would shell the §4 command server-side.
- Follow-up: move `mailbox-dashboard` / `mailbox-caddy` from `build:` to GHCR `image:` pins in the customer compose (MBOX-184) so the customer pull is a true image fetch with no on-device build.
- Follow-up: land `docs/runbook/production-validation.md` with the filled-in §7 `RESULT:` numbers (MBOX-181 acceptance artifact).
