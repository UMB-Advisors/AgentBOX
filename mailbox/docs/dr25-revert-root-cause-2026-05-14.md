# DR-25 Cutover Revert — Root Cause Forensics

> **Date:** 2026-05-14 (afternoon, post-revert)
> **Linear:** STAQPRO-338 (DR-25 cutover), STAQPRO-360 (compose changes), STAQPRO-361 (envelope cosmetic)
> **Appliance:** M1 / mailbox.heronlabsinc.com
> **Authored by:** background session 52ef751c forensics — confirmed via session transcript ccd47da2 turn 392 + on-appliance state probes

## TL;DR

The 2026-05-14 01:47 PDT DR-25 cutover landed three changes; only two were operationally complete and one of those two was silently broken:

| Change | Applied? | Functional? |
|---|---|---|
| `llama-cpp` service in `docker-compose.yml` | ✓ | ✓ container ran, `/health` OK, model loaded |
| Dashboard `environment:` block + `.env` flip to `LOCAL_INFERENCE_RUNTIME=llama-cpp` | ✓ | **✗ proxy URL default in `dashboard/lib/drafting/router.ts:45` was missing the Next.js `/dashboard/` basePath → all drafts that tried to route via the proxy hit a 404** |
| n8n MailBOX-Classify "Call Ollama" node URL → dashboard SDK proxy | **✗ never applied** | n/a — classify continued hitting `http://ollama:11434/api/generate` directly |

The "cutover landed and is operationally green" memory captured at 02:25 PDT was based on a `/health` check on the isolated llama-cpp container, not on production traffic flowing through llama.cpp. **Zero inbound messages arrived in the 7-hour cutover window** (quiet inbox between 01:47-09:08 PDT), so the broken proxy URL never had a chance to fail visibly.

When the operator stopped Ollama at ~09:08 PDT to test cutover purity, classify started failing immediately (the workflow still pointed at Ollama directly). Forced rollback: re-enable Ollama, flip `.env` back to `LOCAL_INFERENCE_RUNTIME=ollama`, restart dashboard, stop llama-cpp.

**The revert was not a quality-driven decision.** It was the only recovery path given two un-applied prerequisites that the in-flight cutover gate failed to catch.

## Forensic timeline (PDT)

| Time | Event | Source of evidence |
|---|---|---|
| 2026-05-13 23:42 → 2026-05-14 00:32 | STAQPRO-338 dashboard SDK abstraction PR #84 rebased + merged | `worktree-staqpro-338` reflog |
| 2026-05-14 00:00–00:43 | Workstation Claude session ccd47da2 prepares cutover; STAQPRO-338 → "In Development"; PR #84 opened | session ccd47da2 turns 28-45 |
| 2026-05-14 00:41 | `infra(compose): add llama-cpp service + session 1 findings (STAQPRO-338)` committed on `dustin/staqpro-338` (workstation worktree only) | git log |
| 2026-05-14 01:46:23 | M1 `.env` backup `pre-dr25` snapshotted | `stat .env.bak-pre-dr25-20260514-014623` |
| 2026-05-14 01:47:11 | `mailbox-llama-cpp-1` container created + started (dustynv image retagged) | `docker inspect` |
| 2026-05-14 02:03:55 | M1 `docker-compose.yml` last modified (final compose state matches `worktree-staqpro-360/docker-compose.yml`) | mtime |
| 2026-05-14 02:25 (UTC 09:25) | Memory `project_dr25_cutover_landed.md` captured — claims "production runs on llama.cpp now" | memory file `originSessionId` |
| 2026-05-14 02:25 → 09:08 | **Zero inbound messages** classified (quiet inbox window) | `mailbox.classification_log` query, 0 rows during the window |
| 2026-05-14 02:25 → 09:08 | Local drafts in the broader 24h window: 11 drafts, **all `model=qwen3:4b-ctx4k` (Ollama tag style, colon)** — confirming NO local draft on the appliance ever logged `qwen3-4b-ctx4k` (llama.cpp name style, dash) | `mailbox.drafts` 7-day rollup |
| 2026-05-14 09:08:17 | M1 `.env` rewritten → `LOCAL_INFERENCE_RUNTIME=ollama` | mtime |
| 2026-05-14 09:08:36 | `mailbox-dashboard` recreated (back on Ollama per env) | `docker inspect` |
| 2026-05-14 09:08:45 | `mailbox-llama-cpp-1` stopped, exit 0 (clean shutdown via runbook §10) | `docker inspect`, llama-cpp `cleaning up before exit` log |
| 2026-05-14 ~09:11 (UTC 16:11) | Session ccd47da2 turn 392 captures the root cause: "**The workflow patch was staged but never applied** ... When we stopped Ollama, classify started failing" + "Confirmed: `http://mailbox-dashboard:3001/dashboard/api/internal/llm/api/generate` → 200 OK (with basePath), `http://mailbox-dashboard:3001/api/internal/llm/api/generate` → 404 (without basePath). **The staged patch document was wrong about the URL**" | session ccd47da2 turns 380–392 |
| 2026-05-14 09:15:30 | M1 `git pull` (legacy form, no `--ff-only`) brings in Nemotron PR #85 + STAQPRO-343 PR #83 | git reflog |
| 2026-05-14 ~09:21 | Memory updates to `project_dr25_cutover_landed.md` and `MEMORY.md` | mtime |
| 2026-05-14 ~16:00 → present | Background session 52ef751c picks up STAQPRO-360, discovers the revert, traces root cause | this document |

## What "operationally green at 02:25" actually meant

The 02:25 memo's claim is technically supportable: the llama-cpp container was alive, `/health` returned 200, the model file loaded, `nvidia-smi` reported ~3.0 GiB GPU, and a synthetic generation probe produced text at 17 t/s. These are all true facts about the **isolated llama-cpp container**.

What was missed:

1. **The n8n MailBOX-Classify workflow was not exercised.** Classify continued to call Ollama directly via `http://ollama:11434/api/generate`. With Ollama up (per the 7-day rollback policy), this was transparent.
2. **The draft path proxy URL returned 404.** `dashboard/lib/drafting/router.ts:45` default `DASHBOARD_LLM_PROXY_BASE = 'http://mailbox-dashboard:3001/api/internal/llm'` omits the Next.js App Router `basePath: '/dashboard'`. M1's `.env` did not override `DASHBOARD_LLM_PROXY_BASE_URL`, so production used the buggy default. The dashboard `pickEndpoint` returned a baseUrl that 404'd.
3. **No real inbound traffic during the window.** The 7-hour cutover happened across local nighttime hours; the inbox produced zero new messages. With no production messages flowing, the broken proxy URL never had a chance to fail visibly. The `/health` probe + a one-shot synthetic generation looked like success.

The pre-cutover envelope-diff gate (runbook v0.1 §6) was supposed to catch (2). The gate's 20-sample diff was apparently run against the wrong URL and either succeeded against a 404 stream (treating 404-with-empty-body as a parsable "no-op" response) or sampled the few requests that hit a different code path. Session ccd47da2 turn 392 explicitly suspects this: *"the prior agent's 'envelope diff PASSED' claim is now suspect — they were probably hitting a 404, which `wget`/`curl` won't return as JSON but the agent may have only checked field types on the few responses that did work."*

## The two un-applied prerequisites

### Prereq A — n8n workflow patch

**File:** `n8n/workflows/MailBOX-Classify.json:264`
**Current:** `"url": "http://ollama:11434/api/generate"`
**Required:** `"url": "http://mailbox-dashboard:3001/dashboard/api/internal/llm/api/generate"`

The patch was documented in `docs/n8n-workflow-patch-staqpro-338.md` (status: STAGED), but the URL in that doc was wrong (missing `/dashboard/`) and the patch was never applied on M1.

This patch must be applied via:

1. Edit the workflow JSON source (`n8n/workflows/MailBOX-Classify.json`) and commit.
2. On the appliance: `docker exec mailbox-n8n-1 n8n import:workflow --input=/home/node/workflows/MailBOX-Classify.json`.
3. Reactivate: `n8n update:workflow --active=true --id=<id>`.
4. `docker compose restart n8n` (the activation flag is in-memory only until n8n restarts).

### Prereq B — dashboard router default URL

**File:** `dashboard/lib/drafting/router.ts:45`
**Current:** `process.env.DASHBOARD_LLM_PROXY_BASE_URL ?? 'http://mailbox-dashboard:3001/api/internal/llm'`
**Required:** `process.env.DASHBOARD_LLM_PROXY_BASE_URL ?? 'http://mailbox-dashboard:3001/dashboard/api/internal/llm'`

The basePath `/dashboard` is configured in `dashboard/next.config.mjs` and every other internal route URL in `MailBOX-Classify.json` correctly uses it (lines 203, 284, 502). This is a one-character source-code fix (well, eight characters — `dashboard/`) but it has to land on master before the cutover can succeed.

**Operational workaround until the code fix lands:** set `DASHBOARD_LLM_PROXY_BASE_URL=http://mailbox-dashboard:3001/dashboard/api/internal/llm` in `.env` on the appliance. This overrides the buggy default. The dashboard `environment:` block in `docker-compose.yml` (already in STAQPRO-360) forwards `DASHBOARD_LLM_PROXY_BASE_URL` if present — verify by adding it to the env: block alongside `LOCAL_INFERENCE_RUNTIME`/`LLAMA_CPP_BASE_URL`/`LLAMA_CPP_MODEL`. Actually — wait — the STAQPRO-360 compose change does NOT forward `DASHBOARD_LLM_PROXY_BASE_URL`. The env-block addition is silent on this var. To use the workaround, BOTH the env addition AND the compose `environment:` block need to include it.

## What was already correct

- **The compose service block for `llama-cpp`** with `--flash-attn --cache-type-k q8_0 --cache-type-v q8_0`, `--n-gpu-layers 99`, `--ctx-size 4096`. Empirically validated: ~3.0 GiB GPU.
- **The dashboard `environment:` forwarding block** for `LOCAL_INFERENCE_RUNTIME`, `LLAMA_CPP_BASE_URL`, `LLAMA_CPP_MODEL`. Critically required as documented in runbook v0.2 §0.
- **The SDK HTTP abstraction in `dashboard/lib/llm/*`** (PR #84). Decoupling at the right layer.
- **The `/api/internal/llm/api/{chat,generate}` proxy route handlers** in the dashboard. These exist and work — the bug is in the URL the *caller* uses to reach them.

## Implications for STAQPRO-360

The STAQPRO-360 PR captures the compose changes correctly. It does NOT — and must NOT silently — close the door on the two un-applied prerequisites. The PR description (or the runbook v0.2 it references) needs to say:

> Merging this PR is necessary but not sufficient for the DR-25 cutover. Two additional changes must land before re-attempting the cutover:
>
> 1. Fix `dashboard/lib/drafting/router.ts:45` default URL to include `/dashboard/` basePath, OR set `DASHBOARD_LLM_PROXY_BASE_URL` explicitly in `.env` AND forward it in the dashboard service's `environment:` block.
> 2. Patch `n8n/workflows/MailBOX-Classify.json` "Call Ollama" node URL to the dashboard proxy URL with the corrected `/dashboard/` basePath, and re-import + reactivate the workflow on the appliance.
>
> Without these, the cutover compose changes are dormant; `LOCAL_INFERENCE_RUNTIME=llama-cpp` will return 404 on draft route and classify continues to bypass the dashboard proxy.

## Recommended next steps

1. **Open a new Linear ticket** (e.g., STAQPRO-362) for the `dashboard/lib/drafting/router.ts:45` source fix. Single-line PR.
2. **Apply the workflow JSON patch** in source (`n8n/workflows/MailBOX-Classify.json:264`) with the corrected URL. Bundle with STAQPRO-360 or as a sibling PR.
3. **Update STAQPRO-338 description** with the lesson: future T2 migrations must include a smoke test that exercises a real (or synthetic-end-to-end-injected) inbound message during the cutover window, not just a `/health` probe.
4. **Add the §6 envelope-diff gate hardening** — fail loudly on 404, do not let "no JSON to parse" count as a pass.

## Cross-links

- STAQPRO-338: original migration
- STAQPRO-360: compose changes (this PR)
- STAQPRO-361: cosmetic envelope leak (separate cleanup)
- Memory: `project_dr25_cutover_landed.md` (now annotated with the revert)
- Patch doc: `docs/n8n-workflow-patch-staqpro-338.md` (URL corrected as of this session)
- Runbook v0.2: `docs/runbook/llamacpp-migration.v0.2.0.md`
- Original cutover session: ccd47da2-1d80-464e-bb7a-cdf50dcb8cb3 (workstation Claude project)
- Forensic session: 52ef751c-f9ed-40ed-874e-7faeec019406 (this background session)
