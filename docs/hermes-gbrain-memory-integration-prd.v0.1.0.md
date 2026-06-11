# Hermes ↔ gBrain Memory Integration — PRD

**Version:** v0.1.0
**Date:** 2026-06-10
**Owner:** Dustin Powers
**Status:** Draft — for review before phasing
**Decision basis:** Topology = *gBrain as the single memory backend* (honcho deferred). Surfaces = all four (interactive chat, Agent Jobs, dashboard, cross-entity brain).

---

## TL;DR

Today neither memory system is wired into the system in any unified way: **honcho** is a hermes-native memory provider that is *disabled and unconfigured*, and **gBrain** is a powerful on-box knowledge store that is *bolted on ad-hoc* (dashboard digest shells + one blog job's custom tools). This PRD makes **gBrain the single, first-class memory backend** for hermes: run it as a Postgres-backed daemon, write a hermes `gbrain` memory provider against it, give Agent Jobs scoped read-only recall (lifting the blunt `skip_memory=True`), repoint dashboard reads to the same daemon, and scope it per entity. honcho is explicitly deferred (local-first/private posture; no user data leaves the appliance). One brain, every surface reads and writes it.

---

## 1. Current state

| Component | What it is | How it's wired today | Gap |
|---|---|---|---|
| **honcho** | hermes-native external *user-model* memory provider (`plugins/memory/honcho/`); cross-session user representation + dialectic reasoning; injects `<memory-context>` into the user message | **Not configured** — no `memory.provider: honcho`, no `HONCHO_*` creds. Interactive sessions use only the `builtin` provider | Off entirely; also sends data off-box if cloud-hosted (rejected) |
| **gBrain** | On-box knowledge/ops graph (bun + PGLite *or* Postgres engine, local embeddings via ollama `qwen3-embedding:0.6b`). Rich CLI: `recall`/`query`/`search`, `capture`, `forget`, `think`, `salience`, `anomalies`, `graph-query`; `serve` (HTTP/MCP) + `auth` clients (read/write/admin scopes) | (a) Dashboard Home digest shells `gbrain salience/anomalies/query` per page load; (b) one Agent Job ("Yes Cacao blog learn-from-published") whose custom tools `capture` editorial lessons; read back by the daily-draft job via an `inject_house_style.py` pre-run script | Not a hermes memory provider; no agent-loop recall; per-call `bun` cold-starts; single-writer PGLite risk under concurrency |
| **Agent Jobs (cron)** | Dashboard-scheduled agent runs | `cron/scheduler.py:~1652` constructs `AIAgent(..., skip_memory=True)` — *"Cron system prompts would corrupt user representations."* Memory subsystem fully disabled in cron | No recall in jobs (except where a job manually shells gbrain) |
| **builtin memory** | hermes's always-on local provider | Active in interactive sessions only | Generic; not the org brain |

**Key constraints (load-bearing):**
- 8 GB Jetson Orin, already co-resident: Qwen3-4B (Ollama), mailbox stack, Postgres, n8n, gBrain, hermes gateway+dashboard, WhatsApp bridge.
- Hermes **pinned to v0.15.1** (`HERMES_REF=927fa7a98`) — 0.16's ≥64K context floor breaks local Qwen3-4B. Injected memory context spends scarce tokens on a 4B model → recall must be **token-budgeted**.
- gBrain PGLite is **single-writer** (today's bulk-write workflow requires stopping `gbrain serve`). One shared read/write brain needs the **Postgres engine + daemon** to be concurrency-safe.

---

## 2. Target architecture

**One store, every surface, via one daemon.**

```
                         ┌──────────────────────────────┐
   interactive turns ───▶│  hermes `gbrain` memory      │
   (CLI/WhatsApp/dash)   │  provider (plugins/memory/   │
                         │  gbrain/)                    │
   Agent Jobs (cron) ───▶│   prefetch()→recall (R)      │──┐
   [read-only mode]      │   sync_turn/on_pre_compress  │  │  HTTP / MCP
                         │     →capture (W, gated)      │  │  (auth: scoped
   dashboard reads ─────▶│   tools: recall/capture/forget  │   clients)
   (digest/graph/CRM)    └──────────────────────────────┘  │
                                                            ▼
                                         ┌─────────────────────────────────┐
                                         │  gbrain serve  (Postgres engine)│
                                         │  one concurrency-safe brain     │
                                         │  entity-scoped via workspace/tags│
                                         └─────────────────────────────────┘
```

### Design decisions

1. **gBrain runs as a Postgres-backed daemon** (`gbrain serve`, HTTP/MCP), as a systemd user unit. Migrate the brain from PGLite → Postgres (the box already runs Postgres). This removes the single-writer bottleneck and the per-call `bun` cold-start; gives one endpoint everything shares.
2. **A hermes `gbrain` memory provider** (`plugins/memory/gbrain/{__init__.py, plugin.yaml, client.py}`) implementing the `MemoryProvider` ABC, talking to the daemon over HTTP/MCP with a scoped auth client. Selected via `memory.provider: gbrain`.
3. **Writes are gated by `agent_context`.** The provider's `initialize(session_id, agent_context=...)` already receives `"primary" | "subagent" | "cron" | "flush"`. Interactive (`primary`) → read+write. Cron → **read-only**. Subagent → read-only. This is the safe replacement for `skip_memory=True`.
4. **Cron gets a read-only memory mode.** Replace the blunt `skip_memory=True` with a `memory_read_only=True` (or `memory_context="cron"`) path so jobs recall but never write — no user-representation corruption, but jobs finally see the brain.
5. **Dashboard repoints to the daemon.** Replace `web_server.py`'s per-load `_gbrain_cli_json/_text` subprocess shells with daemon calls (keep the in-process cache). Same source of truth, faster Home loads.
6. **Cross-entity scoping** via gBrain workspaces/tags + per-entity auth clients (Heron, STATE, CDE, Krunchy, YES, Future Compounds, UMB…), so one brain serves all entities with retrieval scoped per context.

### MemoryProvider → gBrain mapping

| ABC method | gBrain op | Notes |
|---|---|---|
| `is_available()` | daemon health ping / `GBRAIN_DIR` present | no network in hot path beyond a cached health flag |
| `initialize(session_id, agent_context)` | open scoped client; record write-gate | cron/subagent → read-only |
| `prefetch(query, session_id)` | `recall` / `query` (semantic) | returns `<memory-context>` block, **token-budgeted + truncated** |
| `queue_prefetch(query)` | async pre-issue `recall` | warm next turn |
| `sync_turn(...)` / `on_session_end(messages)` | `capture` | **primary only**; distill turn/session, not raw dump |
| `on_pre_compress(messages)` | `capture` summary | persist pre-compression distillation |
| `get_tool_schemas()` / `handle_tool_call()` | explicit `recall` / `capture` / `forget` tools | agent can deliberately remember/recall/forget |
| `system_prompt_block()` | static status header | "memory: gbrain (entity=…, mode=R/RW)" |
| `shutdown()` | close client / drain | |

---

## 3. Phasing (spec-driven, gated)

Each phase has an exit criterion; do not advance until met.

- **Phase 0 — gBrain Postgres daemon.** Migrate brain to Postgres engine; stand up `gbrain serve` (HTTP/MCP) as a systemd unit with an auth client. *Exit:* daemon answers `recall`/`capture` concurrently; existing dashboard digest still renders (still on CLI path).
- **Phase 1 — `gbrain` memory provider (interactive, read-only first).** Implement the provider; wire `prefetch` → recall with a hard token budget. Ship with **writes disabled** (recall-only) behind `memory.provider: gbrain`. *Exit:* a CLI/WhatsApp session recalls a known fact from the brain; token budget respected; no regression on Qwen3-4B context.
- **Phase 2 — Interactive writes + explicit tools.** Enable `capture` on `primary` context + `recall/capture/forget` agent tools + `on_pre_compress`. *Exit:* a fact stated in one session is recalled in a later one; writes are distilled, not raw.
- **Phase 3 — Agent Jobs read-only recall.** Replace cron `skip_memory=True` with `memory_read_only`; provider enforces no-write on `cron`. *Exit:* a job's run shows recalled context in its transcript; brain shows zero job-authored writes.
- **Phase 4 — Dashboard repoint.** Move `web_server.py` reads to the daemon; keep cache. *Exit:* Home/Graph/digest render from daemon; Home load no longer spawns `bun`.
- **Phase 5 — Cross-entity scoping.** Per-entity workspaces/tags + auth clients; retrieval scoped per session/job entity. *Exit:* a YES! job recalls YES! context but not Heron's, unless explicitly cross-scoped.

---

## 4. Risks & mitigations

| Risk | Severity | Mitigation |
|---|---|---|
| Injected recall blows the 4B context budget (v0.15.1 pin) | High | Hard `contextTokens` cap + word-safe truncation in `prefetch` (mirror honcho's `_truncate_to_budget`); make budget configurable; consider routing memory-heavy turns to a cloud fallback model |
| PGLite→Postgres migration / data loss | High | Backup + `gbrain export` before migrate; validate counts; keep PGLite read-only fallback during cutover |
| Resource pressure on 8 GB Orin (daemon + embeds) | Med | Daemon is one process (replaces per-call bun spawns → net win); cap concurrency; reuse local ollama embeddings |
| Write amplification / noisy graph from every turn | Med | Distill on `capture` (facts/summaries, not raw turns); cron never writes; periodic `dream`/dedup |
| Prompt injection via recalled context | Med | hermes already fences recall in `<memory-context>` + cron injection scanner; keep fences; scope read by entity |
| gBrain version/schema drift vs hermes pin | Med | Pin gBrain version alongside `HERMES_REF`; daemon API is the stable contract |
| Concurrent dashboard deploys clobber custom backend (known box hazard) | Med | Follow repo deploy-coordination rules; provider lives in vendored hermes fork file-set |

---

## 5. Out of scope / deferred

- **honcho** (cloud or self-host) — deferred per local-first decision. The provider abstraction keeps it as a future drop-in if true user-modeling/dialectic is later wanted; gBrain covers recall now.
- Replacing the `builtin` provider's mechanics (gbrain registers as the single external provider alongside builtin per the one-external-provider rule).
- New gBrain extraction/ingestion pipelines beyond `capture` (existing `extract`/`dream` jobs unchanged).

---

## 6. Open decisions (need answers before Phase 1)

1. **Brain engine cutover:** migrate the existing PGLite brain in place to Postgres, or stand up a fresh Postgres brain and `import` the export? (Affects history retention.)
2. **Write granularity:** what does `capture` persist per session — model-distilled facts only, full summaries, or both? (Affects graph noise + token cost.)
3. **Entity scoping model:** gBrain workspaces vs tags vs separate auth clients per entity — which is the primary scope boundary?
4. **Recall token budget default** for the Qwen3-4B path (e.g. 800–1500 chars) and whether to auto-bump on cloud-model turns.
5. **Cron change shape:** new `memory_read_only` flag vs reusing `agent_context="cron"` end-to-end through `AIAgent`. (Implementation surface in the vendored fork.)

---

*Next step on approval: convert Phases 0–5 into GSD phase plans; Phase 0 (Postgres daemon) and Phase 1 (read-only provider) are the critical path and independently shippable.*
