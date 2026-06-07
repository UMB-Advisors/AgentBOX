# MailBOX One — T2 Build Log

**Version:** v0.9
**Date:** 2026-04-26
**Hardware:** NVIDIA Jetson Orin Nano 8GB Developer Kit Super
**JetPack:** 6.2 (L4T R36.5)
**Operator:** Dustin
**Supersedes:** v0.8 (2026-04-25)

---

## Headline

**Phase A and A.5 pre-flight complete. Two non-trivial deviations from the runbook surfaced — both resolved by revised Phase D/E plans below. Cleared to begin Phase B.**

This session is a read-only pre-deploy pass on the standalone Next.js dashboard that closes Phase 1 deliverable #6 (approval queue) and ships workflow #3 (Gmail send pipeline). No appliance state was changed. The dashboard source compiles cleanly. The deploy snippets match the runbook verbatim. The Jetson is reachable.

However, inspection of the Jetson's current `docker-compose.yml` and `Caddyfile` revealed two assumptions in `DEPLOY.md` that don't match reality:

1. **An existing stub `dashboard:` compose service is already running** (the static-HTML placeholder from Apr 12). The runbook says "add a `mailbox-dashboard:` service alongside" but the cleaner move is to **replace** the stub, not add a second service that competes for the same `./dashboard` build context.
2. **The Caddyfile has no `handle` blocks** — it's a bare `reverse_proxy n8n:5678` inside the site block. The runbook says "add `handle /dashboard/*` before any catch-all `handle` that proxies n8n" but no such handle exists. We need a structural edit (wrap existing in `handle`, then prepend the dashboard handle), not just an insertion.

Neither is blocking — both have clear revised steps in the §"Revised Phase D/E plan" section below.

---

## Status at a glance

| Component | State |
|---|---|
| Jetson + classify pipeline (from v0.8) | ✅ Stable (untouched this session) |
| `local-board/` Next.js 14 app | ✅ Builds clean, 6 routes generated |
| `local-board/Dockerfile` | ✅ Bakes `BASE_PATH=/dashboard` in builder stage |
| `local-board/deploy/Caddyfile.snippet` | ✅ Verbatim match with `DEPLOY.md` §4 |
| `local-board/deploy/docker-compose.snippet.yml` | ✅ Verbatim match with `DEPLOY.md` §3 |
| Jetson SSH (`bob@192.168.1.45`) | ✅ Reachable; arm64 kernel |
| `/home/bob/mailbox/docker-compose.yml` | ✅ Inspected — has stub `dashboard:` service to replace |
| `/home/bob/mailbox/caddy/Caddyfile` | ✅ Inspected — needs structural restructure into `handle` blocks |
| Production hardening (Postgres + n8n no host ports) | ✅ Already in place |
| Phase A pre-flight | ✅ Complete |
| Phase A.5 Jetson state inspection | ✅ Complete |
| Phase B (rsync to Jetson) | ⏳ Not started |
| n8n `MailBOX-Send` workflow import | ⏳ Not started |

---

## Context: what the dashboard does

`local-board/` is a standalone Next.js 14 app that becomes a 7th container alongside `postgres`, `ollama`, `n8n`, `qdrant`, `caddy`, and the existing classify stack. It exposes a mobile-friendly approval queue at `https://mailbox.heronlabsinc.com/dashboard`. On approve, it fires an n8n webhook (`mailbox-send`) that runs the new `MailBOX-Send` workflow — which loads the draft from Postgres, sends a real Gmail reply via the existing OAuth2 credential, and marks the row `sent` (or `failed` on error).

This is the missing path from "draft sitting in `mailbox.drafts`" to "reply actually goes out" that v0.7 left as the next deliverable.

---

## Actions taken — Phase A pre-flight

### 1. Reviewed `DEPLOY.md` and project `CLAUDE.md` in `local-board/`

`DEPLOY.md` is a 215-line runbook covering 8 steps: rsync source → import n8n workflow → add compose service → add Caddy block → build → start → reload Caddy → verify. Plus a "production hardening" checklist confirming Postgres and n8n don't publish ports to host (only Caddy does).

The runbook references two deploy snippets (`deploy/docker-compose.snippet.yml`, `deploy/Caddyfile.snippet`) and inlines them in the doc. We verified both files exist and match the inline copies verbatim — no drift.

### 2. Local Next.js build (smoke test)

Ran `npm run build` from `local-board/`. Initial run failed with `sh: 1: next: Permission denied` — exit 126.

**Root cause:** the working dir lives on the Seagate external drive, mounted as NTFS3:

```
/dev/sdc2 on /media/bob/Seagate Expansion Drive type ntfs3
  (rw,nosuid,nodev,relatime,uid=1000,gid=1000,windows_names,iocharset=utf8,uhelper=udisks2)
```

NTFS3 with this mount config strips the executable bit from `node_modules/.bin/next`, so the wrapper shell script can't run. Workaround: invoke through Node directly:

```
node node_modules/next/dist/bin/next build
```

That succeeded. Output:

```
✓ Compiled successfully
✓ Generating static pages (6/6)

Route (app)                              Size     First Load JS
┌ ○ /                                    138 B          87.4 kB
├ ƒ /api/drafts                          0 B                0 B
├ ƒ /api/drafts/[id]                     0 B                0 B
├ ƒ /api/drafts/[id]/approve             0 B                0 B
├ ƒ /api/drafts/[id]/edit                0 B                0 B
├ ƒ /api/drafts/[id]/reject              0 B                0 B
├ ƒ /api/drafts/[id]/retry               0 B                0 B
└ ƒ /queue                               5.83 kB        93.1 kB
```

Note: routes show `/queue` not `/dashboard/queue`. That's expected — `BASE_PATH` is unset on the dev box. The Dockerfile sets `ENV BASE_PATH=/dashboard` in the builder stage, so the production image will produce correctly-prefixed routes. The local build is a syntax/type smoke test only, not a routing test.

### 3. Confirmed `Dockerfile` and `next.config.js` honor `BASE_PATH`

`next.config.js`:
```js
basePath: process.env.BASE_PATH || '',
```

`Dockerfile` (stage 2, builder):
```
ENV BASE_PATH=/dashboard
ENV NEXT_TELEMETRY_DISABLED=1
RUN npm run build
```

Standalone output is then copied into a `node:20-alpine` runner stage. This matches the troubleshooting table in `DEPLOY.md` (the basePath/asset-404 pitfall is correctly mitigated).

### 4. Jetson reachability probe

```
ssh -o ConnectTimeout=5 -o BatchMode=yes bob@192.168.1.45 \
  "echo OK; uname -a; ls /home/bob/mailbox/docker-compose.yml /home/bob/mailbox/caddy/Caddyfile"
```

Returned:
```
OK
Linux ubuntu 5.15.185-tegra ... aarch64 GNU/Linux
/home/bob/mailbox/caddy/Caddyfile
/home/bob/mailbox/docker-compose.yml
```

Both target files exist. Detailed contents inspected in Phase A.5 below.

---

## Actions taken — Phase A.5 Jetson state inspection

Pulled the current `docker-compose.yml`, `caddy/Caddyfile`, env keys, dashboard dir contents, and `docker ps` output from the Jetson over SSH (no sudo needed — all files are owned by `bob`). Three significant findings.

### Finding A.5-1 — A stub `dashboard:` service is already running

Current `docker ps` shows a 7th container we hadn't accounted for:

```
mailbox-dashboard-1   Up 12 days (healthy)   0.0.0.0:3000->80/tcp
```

The corresponding compose block is the static-HTML placeholder from project bootstrap:

```yaml
  dashboard:
    build: ./dashboard
    ports: [3000:80]
    healthcheck: { test: wget http://localhost:80/ ... }
    depends_on: { n8n: { condition: service_healthy } }
```

`/home/bob/mailbox/dashboard/` currently contains a 77-byte `Dockerfile` and an 817-byte `index.html` from Apr 12 — the placeholder static page.

**Implication:** Phase B's rsync will clobber that directory with the Next.js source. If we then run Phase D's compose edit verbatim (which adds a *second* service called `mailbox-dashboard:` alongside the existing `dashboard:`), we get two services both building from `./dashboard` with different intents. The cleaner move is to **replace** the stub block with the new `mailbox-dashboard:` block, not add a sibling.

Replacing also drops the `3000:80` host-port publishing on the old stub, which is a small hardening win.

### Finding A.5-2 — Caddyfile has no `handle` blocks at all

Current `Caddyfile` in full:

```caddy
{
  email dustin@heronlabsinc.com
}

mailbox.heronlabsinc.com {
  tls {
    dns cloudflare {env.CLOUDFLARE_API_TOKEN}
  }

  reverse_proxy n8n:5678
}
```

The runbook (`DEPLOY.md` §4) says "add the block from `deploy/Caddyfile.snippet` **before** any catch-all `handle` that proxies n8n at `/`." There is no such `handle` block. The site does an unconditional `reverse_proxy n8n:5678` directly inside the site block, and a bare directive can't coexist with `handle` blocks in the same site.

**Implication:** the `deploy/Caddyfile.snippet` content (just the `handle /dashboard/* { reverse_proxy mailbox-dashboard:3001 }` block) is correct, but inserting it requires a structural edit to wrap the existing `reverse_proxy n8n:5678` in its own `handle` block too. Final shape:

```caddy
mailbox.heronlabsinc.com {
  tls {
    dns cloudflare {env.CLOUDFLARE_API_TOKEN}
  }

  handle /dashboard/* {
    reverse_proxy mailbox-dashboard:3001
  }

  handle {
    reverse_proxy n8n:5678
  }
}
```

### Finding A.5-3 — Production hardening already mostly in place

Host port publishing per `docker ps`:

| Container | Host ports | Public-facing? |
|---|---|---|
| caddy | 80, 443 | ✅ yes — intended |
| postgres | none | ✅ internal only — DEPLOY.md §8 satisfied |
| n8n | none | ✅ internal only — DEPLOY.md §8 satisfied |
| ollama | 11434 | ⚠️ LAN-reachable |
| qdrant | 6333–6334 | ⚠️ LAN-reachable |
| dashboard (stub) | 3000 | ⚠️ goes away when we replace the block |
| ttyd | 7681 | ⚠️ LAN-reachable (intentional — web shell) |

`DEPLOY.md` §8 only flags Postgres and n8n; both are correctly internal-only already. Ollama/qdrant LAN exposure is out of scope for this deploy but worth tracking as a future hardening item.

### Other observations

- `.env` has all required keys (`POSTGRES_USER`, `POSTGRES_PASSWORD`, `POSTGRES_DB`, `CLOUDFLARE_API_TOKEN`). Compose snippet's `${...}` interpolation will resolve cleanly.
- 9 dated backup copies of `docker-compose.yml` in the dir — the operator already has a strong "backup before each edit" pattern. We should follow it.
- A stale `.env.swp` (vim swap) exists. If a vim session is still open on `.env` somewhere, simultaneous edits could collide. Worth confirming before any `.env` change — we don't need any for this deploy, but flag it.
- `mailbox-ttyd` reports `unhealthy` but is running. Not our problem this session.
- No explicit `networks:` block in the compose — services share the default project network `mailbox_default`. The snippet's `networks: - default` is correct for that.
- n8n version confirmed at `1.123.35` (matches v0.8 build log).

---

## Findings / minor flags

| ID | Item | Severity | Notes |
|---|---|---|---|
| BL-20 | NTFS3 mount strips exec bit on `~/Seagate Expansion Drive` | Low | Affects any local dev workflow on this drive — `npm run dev`, direct CLI invocations, etc. Workaround: invoke via `node node_modules/<pkg>/...` or clone the repo into `~/code/` for active dev. Not a deploy blocker — Jetson does its own `docker build`. |
| BL-21 | Dockerfile pins `node:20-alpine`, project CLAUDE.md recommends Node 22 LTS | Low | Next.js 14.2 supports Node 18+, so 20 is fine. Worth aligning to 22 in a follow-up commit but not blocking today. |
| BL-22 | Jetson `docker-compose.yml` and `Caddyfile` diffed against snippets | Resolved | Done in Phase A.5 — see Findings A.5-1 and A.5-2. Spawned BL-23 / BL-24 / BL-25 / BL-26. |
| BL-23 | Stub `dashboard:` compose block must be **replaced** by `mailbox-dashboard:`, not added alongside | Medium | Resolved by revised Phase D plan below. Old service → removed, host port `3000:80` goes away. |
| BL-24 | Caddyfile site block needs structural rewrite (bare `reverse_proxy` → wrapped `handle` blocks) | Medium | Resolved by revised Phase E plan below. Final shape shown in Finding A.5-2. |
| BL-25 | Stale `.env.swp` on Jetson — possible active vim session | Low | Confirm before any `.env` edit. None needed for this deploy, but check if the operator has `.env` open somewhere. |
| BL-26 | LAN exposure of `ollama:11434`, `qdrant:6333-4`, `ttyd:7681` | Low | Out of scope for this deploy. Track for future hardening pass — appliance currently sits behind home LAN, not a v1 blocker. |

No high-severity findings.

---

## Decisions this session

| ID | Decision | Type | Rationale |
|---|---|---|---|
| BL-D19 | Use `node node_modules/next/dist/bin/next build` for local validation, don't fix the NTFS exec bit | Tactical | Mount option is upstream; the deploy artifact is the Docker image built on the Jetson, which doesn't depend on host file permissions. Not worth remounting or relocating the project. |
| BL-D20 | Run a pre-edit Jetson state inspection (Phase A.5) before Phase B rsync | Process | Cheap insurance against silent collisions in `docker-compose.yml` or `Caddyfile`. Adds ~2 min, prevents a half-broken stack. |
| BL-D21 | Defer Node 20 → 22 alignment in `Dockerfile` | Tactical | Out of scope for the deploy. Track as BL-21 follow-up. |
| BL-D22 | **Replace** stub `dashboard:` compose block, don't add `mailbox-dashboard:` alongside | Tactical | Two services both building `./dashboard` would compete for the same source dir with different intents. Replacement also drops the now-unneeded `3000:80` host port. |
| BL-D23 | Restructure Caddy site block into `handle` blocks (not just insert one) | Tactical | Existing site uses bare `reverse_proxy n8n:5678`, which can't coexist with a `handle` block in the same site. Wrap existing in `handle { reverse_proxy n8n:5678 }` after prepending the dashboard handle. |
| BL-D24 | Use `docker compose up -d --remove-orphans` in Phase F | Tactical | Service rename `dashboard` → `mailbox-dashboard` makes the old container an orphan. Without `--remove-orphans` the old `mailbox-dashboard-1` keeps running on port 3000. |
| BL-D25 | Defer ollama / qdrant / ttyd LAN-port hardening | Tactical | Out of scope for this deploy. Track as BL-26. Appliance is on home LAN; not a v1 blocker. |

---

## Open items

| ID | Item | Priority | Notes |
|---|---|---|---|
| BL-15 | Document n8n version pin in T2 production spec | Medium | Carried from v0.8 |
| BL-16 | `N8N_PROXY_HOPS=1` to silence X-Forwarded-For warnings | Low | Carried from v0.8 |
| BL-17 | Gmail push notifications via Pub/Sub | Low | Carried from v0.8 |
| BL-19 | Schedule Trigger config persistence quirk | Watch | Carried from v0.8; no regression observed |
| BL-20 | NTFS3 exec-bit workaround for local Next.js builds | Low | New this session |
| BL-21 | Align Dockerfile Node version to 22 LTS | Low | New this session |
| BL-22 | Inspect Jetson compose + Caddyfile state before Phase B | ✅ Resolved | Done in Phase A.5 — see findings A.5-1 through A.5-3 |
| BL-23 | Stub `dashboard:` block must be replaced, not extended | Medium | Resolved-in-plan via BL-D22; will close when Phase D executes |
| BL-24 | Caddy site needs structural rewrite into `handle` blocks | Medium | Resolved-in-plan via BL-D23; will close when Phase E executes |
| BL-25 | Stale `.env.swp` on Jetson | Low | Confirm before any `.env` edit |
| BL-26 | LAN exposure of `ollama:11434`, `qdrant:6333-4`, `ttyd:7681` | Low | Out of scope for this deploy; future hardening pass |
| BL-7 | Custom jetson-containers Ollama build | Low | Carried from v0.8 |
| BL-6 | nano/vim in T2 base image provisioning | Low | Carried from v0.8 |

**Closed this session:** BL-22 (resolved by Phase A.5 inspection).

---

## Phase 1 deliverable status

| # | PRD Phase 1 Deliverable | Status |
|---|---|---|
| 1 | Assembled appliance running full stack | ✅ Done (v0.1–v0.4) |
| 2 | End-to-end IMAP→classify→draft→queue pipeline | 🟡 Classify done (v0.8). Draft and queue pending. |
| 3 | Local model classification > 80% accuracy | 🟡 5/5 small sample correct, eval set too small to claim |
| 4 | Cloud API draft generation (7/10 complex emails sendable) | ❌ Pending |
| 5 | RAG pipeline with email history | ❌ Pending |
| 6 | Dashboard approval queue | 🟡 **Code complete in `local-board/`, deploy pending** |

The dashboard codebase exists locally and builds clean. Once it's running on the Jetson and the `MailBOX-Send` workflow is active, deliverable #6 closes and the send half of #2 closes. Deliverables #4 and #5 are the next scoped work after that.

---

## What works at end of v0.9

- Same as v0.8 (classify pipeline running clean on the Jetson; nothing was changed there).
- Plus: dashboard source builds locally without errors; deploy artifacts (`Dockerfile`, snippets, `MailBOX-Send.json` workflow export, runbook) are ready and consistent.

---

## Next session — Phase B onward (revised)

Phase A.5 done this session — replaced in the order of operations below by the revised Phase D and Phase E plans that account for the existing stub `dashboard:` service and the bare-`reverse_proxy` Caddyfile.

1. **Phase B — Rsync `local-board/` to `/home/bob/mailbox/dashboard/`** on the Jetson, excluding `node_modules`, `.next`, `.git`. The Apr-12 stub `index.html` and 77-byte `Dockerfile` will be overwritten — that's intended; they are the obsolete placeholder.
2. **Phase C — Import `MailBOX-Send.json`** in n8n, rebind credentials (MailBox Postgres on three nodes, Gmail OAuth2 on the reply node), activate, smoke-test with `{"draft_id":999999}`.
3. **Phase D — Replace the stub `dashboard:` block with `mailbox-dashboard:`** (per BL-D22):
   ```bash
   # On Jetson
   cd /home/bob/mailbox
   cp docker-compose.yml docker-compose.yml.bak.$(date +%Y%m%d-%H%M%S)
   # Edit: delete existing `dashboard:` service block (lines under `dashboard: build: ./dashboard ports: [3000:80] ...`)
   # Insert: the new `mailbox-dashboard:` block from local-board/deploy/docker-compose.snippet.yml
   sudo docker compose config | grep -A 2 'mailbox-dashboard:'
   ```
4. **Phase E — Restructure Caddy site block** (per BL-D23):
   ```bash
   cd /home/bob/mailbox/caddy
   cp Caddyfile Caddyfile.bak.$(date +%Y%m%d-%H%M%S)
   # Edit: replace the bare `reverse_proxy n8n:5678` inside the site block with
   #   handle /dashboard/* { reverse_proxy mailbox-dashboard:3001 }
   #   handle             { reverse_proxy n8n:5678 }
   ```
5. **Phase F — Build and start** (per BL-D24):
   ```bash
   sudo docker compose build mailbox-dashboard       # 3–6 min first time
   sudo docker compose up -d --remove-orphans         # --remove-orphans deletes mailbox-dashboard-1 stub container
   sudo docker logs -f mailbox-dashboard               # wait for "Local: http://0.0.0.0:3001"
   ```
6. **Phase G — Reload Caddy:**
   ```bash
   sudo docker compose exec caddy caddy reload --config /etc/caddy/Caddyfile
   ```
7. **Phase H — Verify:** in-container `wget -qO- http://localhost:3001/dashboard/queue | head -20` returns HTML with `<title>MailBox One</title>`. Phone browser at `https://mailbox.heronlabsinc.com/dashboard` → 307 → renders queue. Approve a real `pending` draft and watch the Gmail send + status flip to `sent`.
8. **Phase I — Production hardening verification:** confirm Postgres and n8n still have no `ports:` block (already true from Phase A.5). Note ollama/qdrant/ttyd LAN exposure for follow-up (BL-26).

Estimated wall-clock: 60–90 min, dominated by the first Jetson Docker build.

---

## Reflections on this session arc

Read-only validation across two sub-phases (A and A.5) was the right shape. Phase A confirmed the dashboard source is healthy. Phase A.5 confirmed the *runbook is not* — at least not for the actual current state of the Jetson. Specifically, two of the runbook's structural assumptions ("there's already a `mailbox-dashboard` to add alongside" and "there's already a `handle` block to insert before") were both wrong, but they were wrong in low-stakes ways that surfaced cleanly through inspection rather than blowing up at execute time.

The cost of Phase A.5: ~3 SSH commands, ~5 minutes, zero appliance state changes. The cost of skipping it would have been a busted compose stack mid-deploy with two competing `dashboard` services and an invalid Caddyfile that fails to reload (Caddy keeps the old config running on reload failure, which would have masked the issue further).

Lesson worth keeping: **runbooks written against an imagined future state are common and not always wrong, but they're never load-bearing without a state inspection.** The MailBOX runbook author wrote it expecting the appliance to look a certain way; the appliance evolved (the stub got installed, the Caddyfile stayed simple) and the runbook didn't. A fresh look at the *actual* state always pays for itself.

Concrete carry-forward for the v1.x build logs: every deploy-runbook session opens with a Phase 0 inspection step before the first edit, codified in the runbook itself rather than added ad-hoc per session.

---

## Related artifacts

- Build log v0.8: `mailbox-one-t2-build-log-v0_8-2026-04-25.md` (closed BL-18, BL-19 self-resolved)
- Dashboard source: `local-board/` (this repo, untracked working tree under `/media/bob/Seagate Expansion Drive/mailbox/local-board/`)
- Deploy runbook: `local-board/DEPLOY.md`
- Compose snippet: `local-board/deploy/docker-compose.snippet.yml`
- Caddy snippet: `local-board/deploy/Caddyfile.snippet`
- n8n send workflow export: `local-board/n8n-workflows/MailBOX-Send.json`
- Jetson compose: `/home/bob/mailbox/docker-compose.yml` (unchanged this session — inspected only; will be edited Phase D)
- Jetson Caddyfile: `/home/bob/mailbox/caddy/Caddyfile` (unchanged this session — inspected only; will be edited Phase E)
- Jetson stub dashboard dir: `/home/bob/mailbox/dashboard/` (77-byte Dockerfile + 817-byte index.html from Apr 12; will be overwritten Phase B)
- Jetson `.env` keys present: `POSTGRES_USER`, `POSTGRES_PASSWORD`, `POSTGRES_DB`, `CLOUDFLARE_API_TOKEN`, `OLLAMA_IMAGE`, `TTYD_USER`, `TTYD_PASS`
- Technical PRD: `thumbox-technical-prd-v2_1-2026-04-16.md` (still pending T2 operational-envelope amendment from v0.8)
