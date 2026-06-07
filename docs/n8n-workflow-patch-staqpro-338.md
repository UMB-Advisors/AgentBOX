# n8n Workflow Patch — STAQPRO-338 / DR-25

> **Status:** STAGED — not yet applied. Apply during the operator session at runbook §7 ("Cutover").
> **Target n8n version:** 2.14.2
> **Affects:** `n8n/workflows/MailBOX-Classify.json` (one node URL); `MailBOX-Draft.json` is **unchanged** (the draft path already pulls `baseUrl` from the dashboard per call).
> **Why staged-not-applied:** the patch only makes sense once the dashboard's `/api/internal/llm/api/generate` proxy is live in production. Applying it ahead of the proxy hard-breaks the classify path. Stage gating is enforced by runbook §1.
>
> **🚨 URL CORRECTION (v0.2 of this doc, 2026-05-14 post-revert forensics):** the URL throughout v0.1 of this doc omitted the Next.js App Router `basePath`. The correct URL is `http://mailbox-dashboard:3001/dashboard/api/internal/llm/api/generate` (with `/dashboard/` prefix). The v0.1 URL `http://mailbox-dashboard:3001/dashboard/api/internal/llm/api/generate` returns **404**. The other classify nodes in `MailBOX-Classify.json` (lines 203, 284, 502) already correctly use the `/dashboard/` prefix — that's the canonical pattern. Verify any operator who acts on this doc uses the corrected URL below; do NOT trust prior cached references. **Also flagged:** `dashboard/lib/drafting/router.ts:45` has the same wrong URL as its `DASHBOARD_LLM_PROXY_BASE` default — that code defect needs fixing in a separate change before this patch can fully succeed. Set `DASHBOARD_LLM_PROXY_BASE_URL=http://mailbox-dashboard:3001/dashboard/api/internal/llm` in `.env` as a workaround until the code is patched.

---

## What this patch does

The classify path historically hits Ollama directly:

    n8n MailBOX-Classify > Ollama Call  →  POST http://ollama:11434/api/generate

DR-25 lands the dashboard's `/api/internal/llm/api/{chat,generate}` proxy. Once the dashboard is upgraded with the Stage 1 code (this PR), we redirect the classify call through the proxy:

    n8n MailBOX-Classify > Ollama Call  →  POST http://mailbox-dashboard:3001/dashboard/api/internal/llm/api/generate

The proxy decides ollama vs llama.cpp based on `LOCAL_INFERENCE_RUNTIME`. n8n no longer needs to know which local runtime is serving the call — the request body shape (Ollama `/api/generate` envelope) and response body shape are identical regardless.

**Cost:** ~5–10 ms extra latency per classify call (one in-cluster HTTP hop). Negligible against the 3–9 s cycle latency.
**Benefit:** the runtime switch is one env var (`LOCAL_INFERENCE_RUNTIME=ollama \| llama-cpp`); zero workflow edits ever again.

The draft path needs **no** workflow edit because the n8n node already uses `={{ $('Mark Start').item.json.baseUrl }}/api/chat`, and the dashboard's `pickEndpoint` now returns either the direct Ollama baseUrl or the dashboard proxy baseUrl based on the runtime env.

---

## The one-line change

File: `n8n/workflows/MailBOX-Classify.json`, line 264:

```diff
-        "url": "http://ollama:11434/api/generate"
+        "url": "http://mailbox-dashboard:3001/dashboard/api/internal/llm/api/generate"
```

That's it. No other field changes; the `Ollama Call` node's body assembly stays as-is (the proxy accepts the exact Ollama `/api/generate` request shape).

---

## Apply procedure

1. **Verify the proxy is live in the running dashboard.** From the appliance:
   ```bash
   curl -s -X POST http://mailbox-dashboard:3001/dashboard/api/internal/llm/api/generate \
     -H 'content-type: application/json' \
     -d '{"model":"qwen3:4b-ctx4k","prompt":"ping","stream":false}' \
     | jq '.response[:40], .done, .eval_count'
   ```
   Expect: a generated response prefix, `done: true`, an `eval_count` integer.
   If the proxy returns 404 or 500, **stop** — the dashboard build doesn't include Stage 1 code. Re-deploy and re-test.

2. **Apply the workflow patch on the appliance**:
   ```bash
   ssh mailbox1
   cd ~/mailbox
   sed -i 's|http://ollama:11434/api/generate|http://mailbox-dashboard:3001/dashboard/api/internal/llm/api/generate|' \
     n8n/workflows/MailBOX-Classify.json

   # Verify the edit took effect
   grep -n 'http://mailbox-dashboard:3001/dashboard/api/internal/llm/api/generate' \
     n8n/workflows/MailBOX-Classify.json
   # Expected: one line.
   ```

3. **Re-import the workflow** (replaces the in-DB definition):
   ```bash
   docker exec mailbox-n8n-1 n8n import:workflow \
     --input=/home/node/workflows/MailBOX-Classify.json
   ```

   (The workflow JSON is bind-mounted into the n8n container at
   `/home/node/workflows/`; `docker compose exec` can read it directly.)

4. **Re-activate the workflow** — `import:workflow` defaults to `active=false` (STAQPRO-181 forensics):
   ```bash
   # Get the workflow id
   docker exec mailbox-postgres-1 psql -U mailbox -d mailbox -tAc \
     "SELECT id FROM workflow_entity WHERE name='MailBOX-Classify';"
   # Activate by id (replace <id>)
   docker exec mailbox-n8n-1 n8n update:workflow --active=true --id=<id>
   ```

5. **Restart n8n** — `update:workflow --active` does not take effect until the n8n process restarts (in-memory cache):
   ```bash
   docker compose restart n8n
   ```

6. **Confirm green per the runbook §8.1 post-cutover observability one-liner** — first cycle's classify_log row appears with `model='qwen3:4b-ctx4k'` (proxy is routing through Ollama) or `model='qwen3-4b-ctx4k'` (proxy is routing through llama.cpp), per the `LOCAL_INFERENCE_RUNTIME` setting.

7. **Commit the workflow change** with a message linking STAQPRO-338:
   ```bash
   cd ~/mailbox
   git add n8n/workflows/MailBOX-Classify.json
   git commit -m "feat(n8n): route classify through dashboard llm proxy (STAQPRO-338 / DR-25)"
   git push origin master
   ```

---

## Rollback

If anything degrades:

    cd ~/mailbox
    git revert HEAD     # if you already committed
    # OR
    sed -i 's|http://mailbox-dashboard:3001/dashboard/api/internal/llm/api/generate|http://ollama:11434/api/generate|' \
      n8n/workflows/MailBOX-Classify.json

    # Re-import + reactivate + restart n8n (same sequence as steps 3–5)

The dashboard proxy stays live; only the n8n endpoint reverts. No data migration, no schema change.

---

## Why the URL is `/dashboard/api/internal/llm/api/generate` (the `/dashboard/` prefix and the doubled `/api`)

n8n's draft node templates `={{ baseUrl }}/api/chat`. To honor that without an n8n workflow change for drafting, the dashboard's `pickEndpoint` returns `baseUrl=http://mailbox-dashboard:3001/dashboard/api/internal/llm` and the proxy lives at `app/api/internal/llm/api/chat/route.ts` so the path resolves cleanly. For consistency, the `/api/generate` proxy lives at the parallel `/api/internal/llm/api/generate`. The doubled `/api` is structurally enforced by the Next.js App Router file path; the `/dashboard/` prefix is the Next.js App Router `basePath` configured in `dashboard/next.config.mjs` and required for every internal-route URL that crosses the docker network into the dashboard.

**Pre-2026-05-14 footgun:** v0.1 of this doc and `dashboard/lib/drafting/router.ts:45` both omitted the `/dashboard/` basePath, causing the proxy URL to 404. This was the silent root cause of the 2026-05-14 M1 cutover revert: `LOCAL_INFERENCE_RUNTIME=llama-cpp` flipped the router to the proxy URL, but the proxy URL returned 404, so drafts never actually flowed through llama.cpp during the 7-hour "soak" window. Confirmed: no draft on the appliance has ever logged `model=qwen3-4b-ctx4k` (the llama.cpp tag style); all local drafts used `model=qwen3:4b-ctx4k` (Ollama tag style). When the operator stopped Ollama to test cutover purity, classify failed (workflow patch un-applied) — forced rollback. See `docs/dr25-revert-root-cause-2026-05-14.md` for the full forensic timeline.

---

## Provenance

- Linear: https://linear.app/staqs/issue/STAQPRO-338
- Decision: DR-25 in `dashboard/.planning/spec/addendum-t2-build-validation-v0_2-2026-05-13.md`
- Runbook: `docs/runbook/llamacpp-migration.v0.1.0.md` (this patch applies at §7 step 7c)
- Stage 1 code: `dashboard/lib/llm/*`, `dashboard/app/api/internal/llm/api/{chat,generate}/route.ts`, `dashboard/lib/drafting/router.ts` (modified)
