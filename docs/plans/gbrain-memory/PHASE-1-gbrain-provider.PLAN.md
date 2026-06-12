# PHASE 1 — hermes `gbrain` Memory Provider (interactive, recall-first)

**Parent:** `docs/hermes-gbrain-memory-integration-prd.v0.1.0.md`
**Goal:** gBrain becomes a first-class hermes memory provider. Interactive sessions (CLI / WhatsApp / dashboard chat) get semantic recall from the brain on every turn, token-budgeted for the local Qwen3-4B. Ships **read-only by default**; the write path exists but is config-gated (Phase 2 flips it).
**Code home:** vendored fork `hermes-agent-main/hermes-agent-main/` (hermes pinned v0.15.1 — implement against that ABI).

## Locked decisions (from PRD §6)

- **D2 Write granularity:** No automatic per-turn writes. Write path (when enabled) = explicit `gbrain_capture` tool + one distilled `on_session_end` summary + `on_pre_compress` distillation. Keeps the graph low-noise; ratchet later.
- **D4 Recall budget:** default `contextChars: 1200` (~300 tokens) — word-boundary-safe truncation (mirror honcho's `_truncate_to_budget` approach). Config knob `memory.gbrain.contextChars`; document bumping to ~4000 for cloud-model sessions.
- **D5 Cron shape (forward-looking):** no new flag; Phase 3 will thread the existing `agent_context="cron"` ABC contract through `AIAgent` in place of `skip_memory=True`. This phase only ensures the provider already enforces the gate (`cron`/`subagent`/`flush` → read-only regardless of config).

## Deliverables

```
plugins/memory/gbrain/
  plugin.yaml        # name, description, pip deps (none beyond stdlib/aiohttp already vendored), config schema
  __init__.py        # GbrainMemoryProvider(MemoryProvider) — discovery contract: class in __init__ implementing the ABC
  client.py          # thin HTTP client for gbrain serve (recall/capture/forget), timeouts, no retries >1
  README.md          # setup: hermes memory setup gbrain; env vars; budget guidance
tests/plugins/test_gbrain_provider.py   # unit tests, HTTP client mocked
docs/plans/gbrain-memory/PHASE-{0,1}.PLAN.md (this file set)
```

## Provider contract (maps to `agent/memory_provider.py` ABC)

| Method | Behavior |
|---|---|
| `name` | `"gbrain"` |
| `is_available()` | True iff `GBRAIN_SERVE_URL` (env or `memory.gbrain.baseUrl`) is set and deps import. **No network call** here; health is checked lazily on first use and cached. |
| `initialize(session_id, agent_context=...)` | Store write-gate: writes allowed only when `agent_context == "primary"` **and** `memory.gbrain.readOnly` is false. v1 default `readOnly: true`. |
| `prefetch(query, session_id)` | `POST recall` (semantic) with `limit`; join results; truncate to `contextChars` word-safe; return plain text (the MemoryManager adds the `<memory-context>` fences — do NOT pre-wrap). Empty string on any error/timeout (≤3s) — recall must never block or break a turn. |
| `queue_prefetch(query)` | Fire-and-forget warmup of the same call; cached for next `prefetch`. |
| `sync_turn(...)` | No-op in v1 (D2). |
| `on_session_end(messages)` | If writes enabled: one distilled summary `capture` (≤500 chars), tagged `source:hermes-session`. Else no-op. |
| `on_pre_compress(messages)` | Same gate; distill what's about to be compressed away. |
| `get_tool_schemas()` | `gbrain_recall(query, limit?)`, `gbrain_capture(text, tags?)`, `gbrain_forget(ref)`. |
| `handle_tool_call()` | recall always allowed; capture/forget return a polite "memory is read-only in this context" string when gated. |
| `system_prompt_block()` | One line: `memory: gbrain (mode=read-only|read-write)`. |
| `shutdown()` | Close client session. |

## Config & env

- `config.yaml`: `memory.provider: gbrain`, `memory.gbrain: {baseUrl, readOnly: true, contextChars: 1200, recallLimit: 5, entityTag: ""}`
- `.env`: `GBRAIN_SERVE_URL`, `GBRAIN_API_TOKEN` (the `hermes-interactive` client from Phase 0).
- `plugin.yaml` config schema must work with `hermes memory setup gbrain` (see `hermes_cli/memory_setup.py` discovery: `find_provider_dir`, schema walk, writes config.yaml + .env).

## Tests (mocked HTTP — no live daemon)

1. Discovery: `load_memory_provider("gbrain")` returns the provider; ABC methods present.
2. `prefetch` truncates to budget on long results; word-boundary safe; returns `""` on connection error and on timeout.
3. Write gate: `agent_context="cron"` → capture tool returns gated message, no HTTP write issued; `"primary"` + `readOnly:false` → write issued.
4. No pre-wrapped fences in `prefetch` output (manager strips them otherwise — assert absence).
5. `is_available()` false when env unset; true when set; never performs I/O.

## Exit criteria

- All new unit tests pass; `python -m py_compile` clean on new files; no changes to existing hermes files except (if required) none — provider is purely additive.
- On-box (deploy step): gateway log shows `Memory provider 'gbrain' registered`; a venv-level functional check (`provider.prefetch("<known brain fact>")`) returns non-empty, ≤ budget; WhatsApp/CLI turn round-trips normally with recall context present.
- Rollback: set `memory.provider: builtin`, restart gateway.
