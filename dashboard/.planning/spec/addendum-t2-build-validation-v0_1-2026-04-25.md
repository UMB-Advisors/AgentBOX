# thUMBox Platform — Addendum: T2 Build Validation & Phase 1 Implementation Learnings

> **Target spec version:** v2.1 → v2.2
> **Addendum started:** 2026-04-25
> **Last updated:** 2026-04-25
> **Status:** ACCUMULATING
> **Author:** Dustin (UMB Group)
> **For:** Board review
> **How to use:** Each section references the spec section it modifies or introduces. When ready to merge, apply each section to the corresponding location in the Technical PRD. This addendum codifies operational and architectural learnings from the MailBox One T2 reference appliance build (build logs v0.1 through v0.9, 2026-04-13 through 2026-04-25).

---

## Strategic Context

The reference T2 appliance build of MailBox One was completed over a 3-day intensive (2026-04-23 → 2026-04-25), validating the core architecture from "no Ollama installed" to "two autonomous workflows: ingest+classify locally, draft generation via cloud LLM." During the build, several specs proved tighter than the PRD anticipated, several tooling assumptions broke, and several decisions had to be locked in operationally.

This addendum brings the PRD into alignment with what was actually validated, captures the operational envelope of T2 hardware under production-like load, and locks in the tactical decisions that should propagate to every subsequent appliance build.

The addendum is **not retroactive criticism** of v2.1 — it's the natural compaction step after a successful first reference build, where lab-derived assumptions are replaced with field-derived ones.

---

## Change Log

| Date | Section | Summary |
|------|---------|---------|
| 2026-04-25 | §3.x (NEW: §3.5) | T2 Operational Envelope — validated specs, memory budget, polling cadence, model context constraints |
| 2026-04-25 | §5.3 (AMEND) | Cloud LLM provider strategy — add NVIDIA NIM as a supported provider, define provider-portability requirement |
| 2026-04-25 | §5.6 (AMEND) | Local model defaults — pin `qwen3:4b-ctx4k` (4096 context) for T2; document KV cache budget |
| 2026-04-25 | §6.x (NEW: §6.4) | Appliance Provisioning Constraints — version pinning, env vars, schema management |
| 2026-04-25 | §7.4 (AMEND) | n8n usage patterns — Postgres node operations, Schedule Trigger config, workflow JSON management |
| 2026-04-25 | §8.x (NEW: §8.6) | Operational Quirks Register — known tooling friction points and workarounds |
| 2026-04-25 | §11 (AMEND) | Risk register additions: NIM rate-limit risk, n8n upgrade risk, dangling FK risk |
| 2026-04-25 | DR-16 (NEW) | Decision: NVIDIA NIM (free dev tier) as Phase 1 cloud LLM provider |
| 2026-04-25 | DR-17 (NEW) | Decision: pin n8n to a specific minor version per appliance build |
| 2026-04-25 | DR-18 (NEW) | Decision: 4096-token context window as T2 default |
| 2026-04-25 | DR-19 (NEW) | Decision: HTTP Request + Header Auth pattern over native LLM nodes |
| 2026-04-25 | DR-20 (NEW) | Decision: Postgres Insert/Update operations over Execute Query for any user-content payloads |
| 2026-04-25 | §1.4 (AMEND) | Draft schema definition added |
| 2026-04-25 | §10 (AMEND) | New SMs: SM-60 through SM-65 (T2 operational baselines) |

---

## §3.5 T2 Operational Envelope (NEW)

> **Source:** MailBox One reference appliance build, 2026-04-23 → 2026-04-25
> **Spec section affected:** New subsection of §3 (Hardware tiers)
> **Change type:** NEW

The T2 tier (NVIDIA Jetson Orin Nano 8GB Developer Kit Super) was validated as Phase 1's primary compute platform per DR-3. Three days of build work and stability testing established the following operational envelope.

### §3.5.1 Memory Budget

T2 uses **unified memory** — CPU and GPU share the same 8 GB pool. Practical usable memory after kernel reservation is ~7.4 GiB.

| Consumer | Steady-state usage |
|---|---|
| Ubuntu 22.04 host kernel + system processes | ~600 MiB |
| Docker daemon + container overhead (6 services) | ~400 MiB |
| Postgres 17 (with shared_buffers + work_mem under query) | ~300 MiB |
| n8n 1.123.35 Node.js process | ~600 MiB |
| Qdrant 1.17 (vector store, mostly idle) | ~150 MiB |
| Caddy + Optimus Brain dashboard | ~50 MiB |
| **Non-Ollama subtotal** | **~2.1 GiB** |
| Ollama + qwen3:4b-ctx4k (model + KV cache + compute graph) | ~3.4 GiB |
| **Combined steady-state** | **~5.5 GiB** |
| **Free headroom** | **~1.9 GiB** |

The 1.9 GiB headroom is consumed by transient allocations: Postgres analytical queries, n8n workflow execution buffers, Qdrant background segment compaction, and short-lived Node.js/Ollama working sets. **A combined model + KV cache footprint above ~4.0 GiB causes intermittent OOM-killer activation** on Ollama under polling load.

### §3.5.2 Validated Constraints

| Constraint | Value | Rationale |
|------------|-------|-----------|
| **Maximum sustainable model** | 4B parameters, Q4_K_M quantization, 4096-token context | Larger context (8K) consumed an additional ~500 MiB of KV cache, leaving ~300 MiB GPU headroom — insufficient for T2 stability under multi-container load. See DR-18. |
| **Maximum concurrent inference calls** | 1–2 | Parallel n8n HTTP Request fan-out to Ollama caused multi-OOM-kill events. Use serial workflow execution (`Execute Once` per node) when fanning out. |
| **Recommended polling cadence** | ≥5 minutes for 5 emails/cycle | At 1-minute cadence with 5 emails per cycle, OOM-killer activation observed. 5-minute cadence operates well within memory headroom. |
| **Required Ollama env var** | `OLLAMA_KEEP_ALIVE=24h` | Default 5-minute model unload causes reload churn on each poll cycle, consuming GPU memory and blocking concurrent requests. 24h pinning is the appliance-correct setting. |
| **Cycle latency (5 emails)** | 5–9 seconds at 4K context | At 8K context, observed 13–17 seconds. The 4K context is faster *and* leaves more headroom. |
| **Generation rate** | 18.66 t/s (Qwen3-4B Q4_K_M, 100% GPU offload, jetson_clocks pinned) | Validated on Orin Nano Super (67 TOPS). |

### §3.5.3 Other-Container Discipline

Operating within T2's memory envelope requires disciplined behavior from non-Ollama containers:

- **Postgres:** keep query result-set sizes small. Avoid analytical queries that load large intermediate results.
- **Qdrant:** maintenance and segment compaction can spike memory. Schedule outside polling windows when possible.
- **n8n:** long execution data blobs (large workflow histories, big file payloads) can inflate the Node.js heap. Periodic pruning of `execution_entity` rows is recommended.
- **Dashboard / Caddy / system:** no special accommodation needed at typical traffic.

### §3.5.4 Phase 2+ Implications

T2's envelope is **viable for Phase 1 (classify + draft)** with the constraints above. **Phase 2 features (relationship graph, longer-context drafts, edit-to-skill learning loop, RAG with extended context) require T3 (Mac mini M4 24 GB) for full feature scope.** The PRD's existing T3 designation is reaffirmed; this build validates that decision empirically.

---

## §5.3 Cloud LLM Provider Strategy (AMEND)

> **Source:** MailBox One reference appliance build, 2026-04-25
> **Spec section affected:** Existing §5.3 (Hybrid local + cloud inference)
> **Change type:** AMEND — add provider-portability requirement and NIM as approved provider

### §5.3.x (Amendment)

DR-4 established hybrid local + cloud inference as the architecture. v2.1 named Anthropic Claude as the assumed cloud provider. **v2.2 amendment:** the cloud LLM provider must be **swappable per appliance build** without code changes — only credential and base-URL configuration.

#### Approved Phase 1 Providers

| Provider | Tier | Use case | Constraints |
|----------|------|----------|-------------|
| **NVIDIA NIM** (free developer tier) | **Default for development & internal/staff appliances** | Draft generation; pre-launch testing; internal dogfooding | 40 RPM, ~1000 req/month. Sufficient for 1-user dev appliance. **Cannot scale to multi-customer production.** No credit card required. |
| **OpenAI** (paid) | Default for paid customer subscriptions | Production draft generation | Pay-as-you-go. ~$0.005–$0.01 per draft on GPT-4o. Cap via OpenAI's usage limit settings. |
| **Anthropic Claude** (paid) | Alternative for premium customer subscriptions | Higher-quality drafts, longer reasoning | $3/$15 per 1M tokens (input/output) on Sonnet 4.6. Premium-tier alignment. |
| **Self-hosted NIM container** (T3+ only) | Enterprise / customers with privacy requirements | Both classify and draft | Requires T3 hardware. Removes external network dependency. Adds operational complexity. |

#### Required Architecture Pattern

To enforce provider portability, the cloud LLM call must use:

- **HTTP Request node** (not native LLM nodes) for the LLM API call
- **Header Auth credential** for the API key (`Authorization: Bearer <key>`)
- **Configurable base URL** stored as a workflow env var or n8n credential field
- **Model name as a configurable string** (not a hardcoded value in workflow JSON)

This pattern (validated in MailBox One workflow #2) means swapping providers requires editing one credential and the model string — no node replacement, no schema migration.

> **Cross-reference:** See DR-19 for full rationale.

#### NIM Rate-Limit Risk (also see §11 risk register)

The NIM free tier's ~1000 req/month cap maps to roughly 30–40 drafts/day at sustainable rate. **For customer appliances, NIM is dev-only.** Track NIM credit consumption monthly via API usage logs; auto-alert when monthly request count crosses 70% of cap.

### §5.3.1 Cloud API Budget Guard (UNCHANGED)

The existing budget guard spec (§5.3.1, v2.1) remains in force. SM-56 and SM-57 apply across all cloud LLM providers. Provider-portability above does not relax budget-guard requirements.

---

## §5.6 Local Model Defaults (AMEND)

> **Source:** MailBox One reference appliance build, 2026-04-25
> **Spec section affected:** Existing §5.6 (Model selection layer)
> **Change type:** AMEND

### §5.6.x (Amendment) — T2 Default Model

The T2 production default is now **`qwen3:4b-ctx4k`** — Qwen3-4B Q4_K_M with `num_ctx 4096`. The model is built from the base `qwen3:4b` via Modelfile (single `PARAMETER num_ctx 4096` override; same template, same stop tokens, same temperature defaults). Build artifact is small (single override over existing weights, no re-download).

Modelfile for T2 default model:

```
FROM qwen3:4b

PARAMETER num_ctx 4096
PARAMETER temperature 0.7
PARAMETER top_k 20
PARAMETER top_p 0.8
PARAMETER stop "<|im_start|>"
PARAMETER stop "<|im_end|>"
```

> **Cross-reference:** See DR-18 for full rationale and §3.5.2 for the operational constraint that drove this decision.

### §5.6.y (Amendment) — Persistent Model Loading

The required Ollama env var on T2 (and T3) is `OLLAMA_KEEP_ALIVE=24h`. Default behavior (5-minute unload) causes reload churn at every polling cycle, increasing both latency and OOM risk. The 24h setting is the appliance-correct default.

This must be set at compose level:

```yaml
ollama:
  image: ${OLLAMA_IMAGE:-ollama/ollama:latest}
  runtime: nvidia
  environment:
    OLLAMA_KEEP_ALIVE: "24h"
```

Add to all appliance compose files (T0, T2, T3).

### §5.6.z (Amendment) — T3 Model Tier

When customers upgrade to T3 (Mac mini M4 24 GB), the larger memory budget enables the full-context model. T3 default: **`qwen3:4b`** (8K context — the original v2.1 spec) with optional larger model variants (e.g., `qwen3:14b` for premium-tier appliances). This re-establishes T3 as the "full feature scope" tier per §3.5.4.

---

## §6.4 Appliance Provisioning Constraints (NEW)

> **Source:** MailBox One reference appliance build, 2026-04-25
> **Spec section affected:** New subsection of §6 (Hardware bill of materials)
> **Change type:** NEW

### §6.4.1 Container Image Version Pinning

Every appliance ships with explicitly-pinned container images. **No `latest` tags in production compose files.** Image-tag drift between customer appliances causes inconsistent behavior, breaks reproducibility of issue diagnosis, and creates support liability.

Phase 1 reference pins (validated 2026-04-25):

| Service | Pinned image |
|---------|--------------|
| n8n | `n8nio/n8n:1.123.35` |
| Postgres | `postgres:17-alpine` |
| Qdrant | `qdrant/qdrant:v1.17.1` |
| Ollama | `ollama/ollama:latest` *(see note)* |
| Caddy | `mailbox-caddy` *(custom build with cloudflare DNS plugin)* |

**Note on Ollama:** the Jetson-specific `dustynv/ollama` images had not received recent updates as of build time, so the official `ollama/ollama:latest` was used. This is the only `latest` tag in the spec and it remains under quarterly review (BL-7). When a Jetson-pinned Ollama tag becomes available with current model support, swap.

> **Cross-reference:** See DR-17 for full rationale.

### §6.4.2 Required Environment Variables

Every appliance build must include the following env vars (in compose `environment:` blocks). Missing any of these causes one of the validated failure modes from the reference build.

| Service | Variable | Value | Required | Reason |
|---------|----------|-------|----------|--------|
| ollama | `OLLAMA_KEEP_ALIVE` | `24h` | **Required** | Prevents 5-minute model unload + reload churn; reduces OOM risk |
| n8n | `N8N_ENCRYPTION_KEY` | (32-char hex, generated per appliance) | **Required** | Encrypts credentials at rest; mismatch causes container crash |
| n8n | `N8N_PROXY_HOPS` | `1` | Recommended | Silences X-Forwarded-For warnings when Caddy fronts n8n |
| n8n | `N8N_SECURE_COOKIE` | `true` (with HTTPS) / `false` (HTTP-only dev) | **Required** | HTTPS production must enable; HTTP dev must disable, or session cookies fail |
| postgres | `POSTGRES_USER`, `POSTGRES_PASSWORD`, `POSTGRES_DB` | (per appliance) | **Required** | Database access |

### §6.4.3 Schema Management

Postgres schemas are created at appliance provisioning time (not on first n8n workflow run). The reference appliance uses a single schema `mailbox` containing:

- `mailbox.inbox_messages` (existing per v2.1)
- `mailbox.drafts` **(new, see §1.4 amendment)**
- Future: `mailbox.embeddings`, `mailbox.skills`, `mailbox.api_usage`, `mailbox.contacts` per Phase 2 scope

Schema definitions ship as a versioned SQL migration set. n8n workflows assume schema is present; do not auto-create from workflow logic.

### §6.4.4 Workflow JSON as Source of Truth

n8n workflows are versioned outside n8n's UI. The canonical source is exported JSON in `git`. Workflows are imported during appliance provisioning. The n8n UI is treated as **advisory only** for production appliances (see §8.6.x for known UI-vs-DB inconsistencies).

> **Cross-reference:** See §7.4 amendment for n8n usage patterns.

---

## §7.4 n8n Usage Patterns (AMEND)

> **Source:** MailBox One reference appliance build, 2026-04-23 → 2026-04-25
> **Spec section affected:** Existing §7.4 (n8n workflow architecture)
> **Change type:** AMEND — add operational guidance

### §7.4.x (Amendment) — Postgres Node Operation Selection

**Use `Insert` and `Update` operations over `Execute Query`** when any parameter could contain user-generated content. The `Execute Query` node uses comma-separated parameter syntax that splits on every comma — including commas inside string fields like email bodies — corrupting parameter alignment.

Validated pattern:

| Use case | Operation |
|----------|-----------|
| Insert a row with text fields containing potentially commas/quotes | `Insert` (use field-mapped column UI) |
| Update a row with similar fields | `Update` |
| Atomic CTE / transaction-bounded multi-statement work | `Execute Query` only when no user content in parameters |
| Read-only SELECT (no parameters) | `Execute Query` is fine |
| Read-only SELECT with parameters | `Insert/Update` cannot SELECT; use `Execute Query` and ensure params are integer/safe types |

> **Cross-reference:** See DR-20 for full rationale.

### §7.4.y (Amendment) — Gmail Trigger Replacement

The Gmail Trigger node is **not approved for production use** in MailBox One v1. Multiple n8n GitHub issues (#14322, #27867) confirm the node has a long-standing bug where scheduled polling silently fails to fire even when the workflow is active and credentials are valid. Manual execution works; scheduled does not.

**Approved replacement pattern** (validated in MailBox One workflow #1):

```
Schedule Trigger (every 5 min)
  → Gmail Get Many (label-filtered, limit 20, simplify off)
  → ... rest of workflow ...
  → Postgres Insert with ON CONFLICT (message_id) DO NOTHING
```

The Postgres dedup constraint ensures idempotency: even though Get Many fetches the same emails on every poll, only new ones get inserted. This pattern uses ~5x more Gmail API quota than a true trigger, but Gmail's quota is 1 billion units/day per user — far above MailBox One's typical usage.

### §7.4.z (Amendment) — Schedule Trigger Configuration Persistence

The Schedule Trigger node has known issues with `minutesInterval` field persistence in n8n 1.123.35. The field is sometimes stripped on workflow save or reload, causing the trigger to revert to a 1-minute default cadence. Behavior is intermittent.

Workaround: manage the Schedule Trigger config via direct DB update in `workflow_entity.nodes` JSON. After any UI edit to the Schedule Trigger node, verify the persisted state via:

```sql
SELECT nodes->0->'parameters'->'rule' FROM workflow_entity WHERE name = 'WorkflowName';
```

> **Cross-reference:** See §8.6.x (operational quirks register) for the full known-issue write-up.

### §7.4.aa (Amendment) — LLM Node Pattern

For all LLM API calls, use **HTTP Request node + Header Auth credential**, not native LLM nodes (e.g., the n8n OpenAI node). The native nodes:

- Do not support custom base URLs in n8n 1.123.35 (blocking NIM use)
- Use credential schemas tied to specific provider versions (creating upgrade fragility)
- Hide the JSON body, making prompt iteration harder

The HTTP Request + Header Auth pattern is provider-portable and stable. Use this pattern for OpenAI, Anthropic, NIM, OpenRouter, Together, Groq, or any OpenAI-compatible endpoint.

> **Cross-reference:** See DR-19.

---

## §8.6 Operational Quirks Register (NEW)

> **Source:** MailBox One reference appliance build, 2026-04-23 → 2026-04-25
> **Spec section affected:** New subsection of §8 (Security & operations)
> **Change type:** NEW

A collection of validated tooling friction points and their established workarounds. Each entry includes the symptom, root cause, and operational pattern. New appliance builds should anticipate these issues; CI/provisioning should validate workarounds are in place.

### §8.6.1 n8n Schedule Trigger Field Stripping

**Symptom:** Schedule Trigger configured for "every X minutes" reverts to a 1-minute default cadence. The `minutesInterval` value is missing from the persisted workflow JSON.

**Root cause:** n8n 1.123.35's Schedule Trigger node deserializer normalizes parameters on workflow load and removes fields it doesn't recognize as valid.

**Workaround:** After any edit to the Schedule Trigger, verify the persisted JSON via SQL. If the field is stripped, restore it via direct UPDATE on `workflow_entity.nodes`. Do not edit the node further from the UI — UI edits trigger re-strip.

**Long-term fix:** Track via BL-19. Investigate typeVersion compatibility, or move to alternative scheduling pattern (host cron + webhook).

### §8.6.2 Postgres Execute Query Comma-Splitting

**Symptom:** Postgres Execute Query parameters get scrambled when any parameter value contains a comma. Resulting SQL fails with `invalid input syntax for type integer: "<text-fragment>"` or similar.

**Root cause:** The Replacements field in the Execute Query node parses by splitting on `,`. Email bodies, sentences with commas, and JSON-as-string all corrupt the alignment.

**Workaround:** Use `Insert` or `Update` operations instead, which use field-mapped column UI. For atomic multi-statement work, use a Postgres function called via Execute Query with no embedded user content.

> **Cross-reference:** See §7.4.x amendment.

### §8.6.3 Gmail Trigger Silent Polling Failure

**Symptom:** Workflow is active, credentials are valid, manual execution works. Scheduled polling produces zero executions.

**Root cause:** Long-standing n8n bug. Documented in GitHub issues #14322, #27867.

**Workaround:** Replace with Schedule Trigger + Gmail Get Many. See §7.4.y amendment.

### §8.6.4 n8n Major Version Workflow JSON Incompatibility

**Symptom:** Workflow JSON exported from n8n 2.x fails to import / activate in n8n 1.x with `Cannot read properties of undefined (reading 'execute')` errors.

**Root cause:** Node `typeVersion` values in JSON exports reference node implementations that may not exist in older versions. Notably: Gmail Trigger 1.3, Set 3.4, HTTP Request 4.4, Postgres 2.6 are 2.x-only.

**Workaround:** Treat workflow JSON as version-specific. When pinning n8n version (DR-17), pin the workflow JSON exports to that version. For major n8n upgrades, plan a workflow regeneration (not import) step.

### §8.6.5 Cloud DNS Resolution Inside Containers

**Symptom:** EAI_AGAIN errors in n8n logs, intermittent. External API calls fail even though host has working DNS.

**Root cause:** Transient. Docker's embedded DNS resolver (127.0.0.11) occasionally has propagation lag on hostname changes.

**Workaround:** Restart the affected container. If recurring, add upstream DNS servers explicitly to compose `dns:` block.

### §8.6.6 NIM Free-Tier Rate Limits

**Symptom:** 429 errors after sustained API usage. NIM credits exhausted before month-end.

**Root cause:** NVIDIA NIM free developer tier caps at 40 RPM and ~1000 req/month per account. No prepay option exists for the free tier.

**Workaround:** Track per-account usage. For production appliances, switch to OpenAI or Anthropic (paid). For dev/internal appliances on NIM, alert at 70% monthly cap and pause polling at 95%.

> **Cross-reference:** See §11 risk register and §5.3 amendment.

---

## §1.4 Draft Schema Definition (AMEND)

> **Source:** MailBox One reference appliance build, 2026-04-25
> **Spec section affected:** Existing §1.4 (Functional requirements — Response Generation)
> **Change type:** AMEND

### §1.4.x (Amendment) — Drafts Table

The draft persistence layer is defined by `mailbox.drafts`:

```sql
CREATE TABLE mailbox.drafts (
    id SERIAL PRIMARY KEY,
    inbox_message_id INTEGER NOT NULL 
      REFERENCES mailbox.inbox_messages(id) ON DELETE CASCADE,
    draft_subject TEXT,
    draft_body TEXT NOT NULL,
    model TEXT NOT NULL,
    input_tokens INTEGER,
    output_tokens INTEGER,
    cost_usd NUMERIC(10,6),
    status TEXT NOT NULL DEFAULT 'pending'
      CHECK (status IN ('pending', 'approved', 'rejected', 'edited', 'sent', 'failed')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    error_message TEXT
);

CREATE INDEX idx_drafts_status ON mailbox.drafts(status);
CREATE INDEX idx_drafts_message ON mailbox.drafts(inbox_message_id);

ALTER TABLE mailbox.inbox_messages 
  ADD COLUMN draft_id INTEGER REFERENCES mailbox.drafts(id);
```

The `status` lifecycle:

| Status | Meaning |
|--------|---------|
| `pending` | Generated, awaiting human review (Phase 1 end-state) |
| `approved` | Human approved, queued for send |
| `rejected` | Human rejected |
| `edited` | Human modified before approval; `draft_body` reflects edited form. Useful for edit-to-skill learning loop (§7.7.1, Phase 2) |
| `sent` | SMTP delivery succeeded |
| `failed` | SMTP delivery failed; `error_message` populated |

The bidirectional FK (`drafts.inbox_message_id` → `inbox_messages.id` and `inbox_messages.draft_id` → `drafts.id`) enables fast lookup in either direction. Per-row token counts and cost capture support cost forecasting and per-customer billing reconciliation in Phase 3.

---

## §10. Success Metrics (AMEND)

> **Source:** MailBox One reference appliance build, 2026-04-25
> **Spec section affected:** Existing §10 (Success Metrics — Technical)
> **Change type:** AMEND — new SMs

| ID | Metric | Target | Measurement |
|----|--------|--------|-------------|
| SM-60 | T2 cycle latency for 5-email classify batch | < 10s p95 | n8n execution_entity stoppedAt - startedAt for MailBox workflow |
| SM-61 | T2 OOM-killer activations on Ollama runner per 24h under default polling | 0 events | `docker logs ollama \| grep "signal: killed"` |
| SM-62 | Cloud LLM provider portability — provider swap time | < 30 min from credential creation to first successful draft | Operational drill, tracked in build log |
| SM-63 | Draft generation latency (cloud LLM, 1 email) | < 3s p95 | n8n execution_entity for MailBox-Drafts |
| SM-64 | Draft persistence success rate (drafts written / draft generation calls) | > 99% | `SELECT count(*) FROM drafts` vs. n8n execution count |
| SM-65 | Workflow JSON drift detection — workflow_entity vs. exported canonical JSON | Zero drift weekly | Provisioning CI runs `git diff` on exported workflow against canonical |

---

## §11. Risk Register (AMEND)

> **Source:** MailBox One reference appliance build, 2026-04-25
> **Spec section affected:** Existing §11 (Technical Risk Register)
> **Change type:** AMEND — new entries

| Risk | Probability | Impact | Mitigation |
|------|------------|--------|------------|
| **NIM free-tier rate limit causes draft generation backpressure** | Medium (in dev), High (if used in production) | Medium — drafts queue up, latency increases | NIM is dev/internal-only per §5.3. Production uses paid OpenAI/Anthropic. Per-appliance daily cap monitor; alert at 70% monthly cap. |
| **n8n minor version upgrade silently breaks workflow JSON** | Medium | High — appliance stops processing email | Pin n8n version per appliance build (DR-17). Test version upgrades in staging before pushing to fleet. Workflow regen, not import, on major upgrades (§8.6.4). |
| **Postgres FK orphans (dangling draft_id pointers) accumulate from earlier debug sessions** | Low | Low — query results show NULL drafts | Periodic `pg_check` job validates FK integrity. ON DELETE CASCADE on `drafts.inbox_message_id` is the correct primary safeguard. |
| **T2 OOM-killer activates Ollama runner under multi-container memory pressure** | Low (post-§3.5 envelope) | High — cycle errors, dropped classifications | Operate within §3.5.2 envelope. Monitor `signal: killed` events (SM-61). If recurring, investigate non-Ollama containers for memory regressions. |
| **Cloud DNS resolution inside containers occasionally fails (EAI_AGAIN)** | Low | Low — transient errors, automatic retry succeeds | Container restart resolves. If recurring, add explicit upstream DNS in compose. |
| **Workflow JSON in n8n DB diverges from canonical exports under operator UI editing** | Medium | Medium — appliance behavior drifts from spec | Treat n8n UI as advisory (§6.4.4). All workflow changes flow through git. CI validates SM-65. |

---

## Decision Records (NEW)

### DR-16: NVIDIA NIM (Free Dev Tier) as Phase 1 Cloud LLM Provider for Internal & Dev Appliances

**Decision:** Use NVIDIA NIM's free developer tier (`integrate.api.nvidia.com/v1`, model `meta/llama-3.3-70b-instruct`) as the cloud LLM provider for development and internal/staff MailBox One appliances during Phase 1.

**Type:** Strategic | **Date:** 2026-04-25 | **Status:** Approved

**Context:** Phase 1 deliverable #4 requires cloud-API draft generation for `action_required` emails. The original assumption (per DR-4 era v2.0) was Anthropic Claude as primary. During the reference build, OpenAI was also evaluated. OpenAI's billing wall (insufficient quota error on a fresh account) blocked progress; NVIDIA NIM's free tier was workable in 5 minutes with no credit card.

**Alternatives considered:**

| Option | Trade-off |
|--------|-----------|
| Anthropic Claude (Sonnet 4.6) | Higher quality writing. Paid only. Best fit for production premium tier. |
| OpenAI GPT-4o | Strong production-grade default. Paid only ($2.50/$10 per 1M tokens). Reasonable for mid-tier subscriptions. |
| Google Gemini 2.5 Flash | Has free tier (10 RPM, daily limits). Quality reasonable but ecosystem alignment weaker. |
| Self-hosted larger model on T2 | Out of memory budget per §3.5. |
| Run NIM container locally on T2 | Container ARM64 availability not validated as of build time. Tracked in NC-2-OPENSHELL. |

**Rationale:**

1. **Strategic alignment.** thUMBox is in NVIDIA's hardware ecosystem. Using NVIDIA's hosted inference for dev work strengthens the narrative that the entire stack (T2/T3 hardware, NIM inference) is NVIDIA-aligned.
2. **Zero billing friction in dev.** No credit card, working in 5 minutes. Ideal for staff appliances and pre-launch testing.
3. **Open-weight models.** Llama 3.3-70B is open-weight; if NIM rate limits or pricing change adversely, model can be self-hosted on T3 (or external GPU).
4. **OpenAI-compatible.** API surface is standard. Provider swap is a credential change.

**Cost:** $0 for dev/internal. Production migration cost (DR per customer): $5–$30/month depending on volume and provider chosen.

**Caveats:**
- 40 RPM and ~1000 req/month free-tier cap is **insufficient for paid customer production**. Customer appliances must use paid OpenAI/Anthropic or self-hosted NIM.
- NIM as a hosted free service is a "developer evaluation perk" — terms may change unilaterally. Production should not depend on free-tier availability.

**Affects:** §5.3 (cloud LLM provider strategy), §11 risk register, MailBox One workflow #2 implementation.

---

### DR-17: Pin n8n to a Specific Minor Version per Appliance Build

**Decision:** Every appliance ships with n8n pinned to an explicit minor version (currently `n8nio/n8n:1.123.35`). No `latest`, no major-version-only pins.

**Type:** Tactical | **Date:** 2026-04-25 | **Status:** Approved

**Context:** During the reference build, an n8n 2.x → 1.x downgrade was forced by the 2.x publish/scheduling bug. The downgrade revealed that workflow JSON exports between major versions are incompatible at the `typeVersion` level, requiring workflow regeneration on major version moves. Even between minor versions, behavior changes (Schedule Trigger field stripping, Postgres node UI variants) introduce inconsistency across the fleet if not pinned.

**Alternatives considered:**

| Option | Trade-off |
|--------|-----------|
| Pin to `latest` | Breaks reproducibility; bug-fix changes can break workflows. |
| Pin to major only (`1.x`) | Minor version drift introduces silent UI/behavior changes. |
| Pin per minor version (this decision) | Slight maintenance overhead — periodic version review and qualification. |
| Pin per patch version | Excessive churn; patch updates rarely break things. |

**Rationale:**

1. **Reproducibility.** Customer appliances must behave identically; image-tag drift breaks support.
2. **Workflow JSON compatibility.** Pinning by minor version aligns with workflow JSON's typeVersion stability.
3. **Diagnostic consistency.** When debugging field reports, the n8n version is known.

**Cost:** ~2 hours quarterly to qualify a new pin and update build images.

**Affects:** §6.4.1 (provisioning constraints), §8.6.4 (workflow JSON incompatibility quirk), §11 risk register.

---

### DR-18: 4096-Token Context Window as T2 Default

**Decision:** Pin the T2 default Qwen3 model to 4096-token context (`qwen3:4b-ctx4k` named alias) instead of the default 8192.

**Type:** Tactical | **Date:** 2026-04-25 | **Status:** Approved

**Context:** Build-log v0.7 documented OOM-killer activations on Ollama runner under polling load. The cause was traced to ~300 MiB of GPU memory headroom after model + KV cache load. Reducing `num_ctx` from 8192 to 4096 freed ~500 MiB of KV cache, eliminating OOM kills. Cycle latency also improved (5–9s vs. 13–17s).

**Alternatives considered:**

| Option | Trade-off |
|--------|-----------|
| Keep 8192 context, downsize model to 1.7B | Smaller model degrades classification quality. |
| Keep 8192 context, force serial inference | Reduces concurrency wins but doesn't address marginal headroom. |
| Move Ollama to host (out of Docker) | Bypasses Docker memory overhead but breaks compose-managed appliance model. |
| Force users to T3 hardware | Removes T2 from the product line; contradicts DR-3. |
| **4096 context with 4B model (this decision)** | **Frees 500 MiB headroom; ~99% of emails are under 4K tokens including the prompt.** |

**Rationale:**

1. **Real-world email length.** Validated: typical emails (including signatures) fit within 4K tokens with 1K+ headroom for the prompt template.
2. **Hardware envelope respect.** T2 is constrained; 4K context lets the model ride within budget without other-container starvation.
3. **Reversibility.** T3 (Mac mini M4 24 GB) reverts to 8K (or larger) context — handled per §5.6.z.

**Caveats:**
- Long emails (newsletters, deeply quoted threads) may be silently truncated by Qwen3 from the front. Acceptable for classification (subject + first lines usually sufficient); for draft generation, may degrade quality on edge cases. Mitigation: signature stripping (BL-21) reduces typical body length; thread-quoting strip (future) reduces it further.

**Affects:** §3.5 (T2 envelope), §5.6 (model defaults), §11 risk register.

---

### DR-19: HTTP Request + Header Auth Pattern over Native LLM Nodes

**Decision:** All cloud LLM API calls use `HTTP Request` node + `Header Auth` credential, not native LLM nodes (e.g., n8n's OpenAI node, Anthropic node).

**Type:** Tactical | **Date:** 2026-04-25 | **Status:** Approved

**Context:** During build of MailBox One workflow #2, the n8n OpenAI node was attempted with NIM's base URL — failed because n8n 1.123.35's OpenAI credential type does not expose a Base URL field. The HTTP Request + Header Auth fallback worked immediately and is provider-portable.

**Alternatives considered:**

| Option | Trade-off |
|--------|-----------|
| Use native nodes per provider | Forces version-specific node updates; provider lock-in; Base URL gating. |
| Use OpenAI node with HTTP fallback for other providers | Inconsistent across workflows; harder to maintain. |
| **HTTP Request + Header Auth (this decision)** | **Single pattern for all providers; portable; clean.** |

**Rationale:**

1. **Provider portability.** Per §5.3, providers must be swappable. Native nodes break this.
2. **Stability across n8n upgrades.** HTTP Request node is core; less likely to change behavior than provider-specific nodes.
3. **Visible JSON body.** Prompt iteration is easier when the full request shape is visible in workflow JSON.

**Cost:** Slightly more verbose node config than native nodes; offset by reduced upgrade fragility.

**Affects:** §7.4.aa (n8n usage patterns), §5.3 (provider strategy).

---

### DR-20: Postgres Insert/Update Operations over Execute Query for User Content

**Decision:** Postgres node uses `Insert` or `Update` operations whenever any parameter could contain user-generated content. `Execute Query` is reserved for SELECT and admin-only / no-user-content writes.

**Type:** Tactical | **Date:** 2026-04-25 | **Status:** Approved

**Context:** Build of MailBox One workflow #2 hit the Execute Query comma-splitting bug (§8.6.2). The draft body, containing natural-language commas, scrambled the parameter list, causing SQL errors. Insert/Update operations use field-mapped column UI, which is comma-safe.

**Alternatives considered:**

| Option | Trade-off |
|--------|-----------|
| Continue using Execute Query with manual escape sequences | Fragile, security-adjacent (SQL injection risk if escapes are missed). |
| Use a Postgres function called via Execute Query | More setup; functions need to be deployed and maintained per appliance. |
| Switch to Insert/Update (this decision) | Native n8n operation; clean column mapping; comma-safe. |

**Rationale:**

1. **Correctness.** Field-mapped UI eliminates the entire class of comma/quote-escape bugs.
2. **Maintainability.** Column-by-column mapping is more readable than positional parameter lists.
3. **Consistent pattern.** Both MailBox One workflows now use Insert/Update; consistent across the codebase.

**Cost:** Slightly more verbose for multi-table atomic writes (split into separate Insert + Update nodes instead of a single Execute Query CTE).

**Affects:** §7.4.x (n8n usage patterns), §8.6.2 (operational quirks register).

---

## Open Questions (Updated)

The following NEEDS_CLARIFICATION items remain from prior PRD versions; this addendum does not resolve them but flags ones that gain context from the reference build.

| # | Question | Status update |
|---|----------|---------------|
| NC-1 | Remote access (WireGuard/Tailscale) in v1? | Unchanged. Reference build uses LAN access only. |
| NC-2 | SMS/Slack notifications in v1? | Unchanged. |
| NC-2-OPENSHELL | OpenShell ARM64 availability for T2? | **Validated as recommended: restrict OpenClaw to T3+.** Reference T2 build does not include OpenClaw; T3 spec still TBD. |
| NC-3 | Target initial production run size? | **Increased relevance.** With validated T2 envelope and pinned versions (DR-17), small-batch production is now technically feasible. Business decision pending. |
| NC-4 | BYOK API keys vs. pooled UMB Group key? | **Strongly affected by §5.3 amendment.** With provider portability, BYOK becomes simpler. Recommend BYOK as default, pooled key as upgrade option. |
| NC-6 | Container registry hosting location? | Unchanged. |
| NC-7 | Anthropic API batch verification support for speculative decoding? | Unchanged. |

---

## Migration Plan

When this addendum merges into the next PRD revision (target: v2.2):

1. **§3.5** (T2 Operational Envelope) inserts as a new subsection of §3
2. **§5.3** receives an inline amendment (not a replacement); add NIM and provider portability requirements
3. **§5.6** receives inline amendments for T2 model default and `OLLAMA_KEEP_ALIVE`
4. **§6.4** (Appliance Provisioning Constraints) inserts as a new subsection of §6
5. **§7.4** receives inline amendments for Postgres node, Gmail Trigger replacement, Schedule Trigger persistence, and HTTP Request LLM pattern
6. **§8.6** (Operational Quirks Register) inserts as a new subsection of §8
7. **§1.4** receives the drafts schema definition as an inline amendment
8. **§10** receives SM-60 through SM-65 as new rows in the metrics table
9. **§11** receives new risk register rows
10. **DR-16 through DR-20** insert into §12 (Decision Records) in numerical order
11. **Changelog** in PRD frontmatter updated to reference v2.2 and this addendum's date

The `addendum-t2-build-validation` source file is archived but retained for traceability per §6.4.4 (workflow JSON as source of truth — same principle applied to PRD addendum source).

---

## Reflections on the Reference Build

Three observations worth capturing as institutional knowledge before they fade:

**1. The PRD-to-build gap was smaller than expected on architecture, larger than expected on tooling.** Architecturally, v2.1 held up well — the hybrid local/cloud model, T2 hardware tier, n8n + Postgres + Ollama topology, and Optimus Brain plugin dashboard all proved sound. Where the PRD didn't anticipate friction was in the operational details: n8n UI/DB sync inconsistency, the Gmail Trigger bug, Ollama memory headroom under multi-container load, Postgres node operation selection. These became §8.6 (Operational Quirks Register).

**2. Provider portability paid off immediately.** The OpenAI → NVIDIA NIM swap was a 30-minute change, not a workflow rebuild. This pattern (HTTP Request + Header Auth, configurable model string, swappable credentials) should be the default for any LLM API integration in any future appliance feature.

**3. The 8GB unified memory budget on T2 is a real product-spec constraint, not an optimization concern.** §3.5.2 documents this explicitly because future feature additions (RAG with longer context, multi-agent workflows, learning loop with skill injection) all eat into the same memory pool. Phase 2 features that exceed the T2 envelope must explicitly require T3 — there's no cheap fix.

The reference T2 appliance is now a known-good operational baseline. New appliance builds should reproduce its compose, env vars, schema, workflow JSONs, and tooling versions exactly. Variations from this baseline are explicit decisions, not accidents.

---

## Related Artifacts

- Build logs v0.1 through v0.9 — source of all observations in this addendum
- `thumbox-technical-prd-v2_1-2026-04-16.md` — current target spec
- `thumbox-business-prd-v2_1-2026-04-16.md` — companion (no amendments in this round)
- `addendum-openclaw-integration.md` — prior addendum (merged in v2.1)
- `addendum-optimus-brain-plugin-dashboard-v0_1-2026-04-05.md` — prior addendum (merged in v2.1)
