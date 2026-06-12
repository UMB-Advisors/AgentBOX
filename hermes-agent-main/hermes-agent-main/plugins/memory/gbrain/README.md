# gbrain memory provider

Recall-first hermes memory provider backed by a local
[gbrain](../../../../gbrain-master) daemon (`gbrain serve --http`,
MCP Streamable HTTP on `127.0.0.1:3131` by default).

Every interactive turn gets a semantic recall block injected from the
brain, word-safe-truncated to a configurable character budget. **Read-only
by default** — the write path (explicit `gbrain_capture` tool, one
distilled session-end summary, pre-compress distillation) only runs when
`memory.gbrain.readOnly: false` AND the agent context is `primary`
(`cron`/`subagent`/`flush` are read-only regardless of config).

## Setup

```bash
hermes memory setup gbrain
```

or manually:

1. Make sure a daemon is running: `gbrain serve --http` (loopback `:3131`).
2. Mint credentials on the gbrain host:
   - OAuth (preferred): `gbrain auth register-client hermes-interactive \
     --grant-types client_credentials --scopes 'read write'` → client id +
     one-time secret. Tokens (~1h TTL) are fetched and refreshed
     automatically.
   - Static (legacy): `gbrain auth create hermes-interactive` → bearer token.
3. `$HERMES_HOME/.env`:

   ```
   GBRAIN_SERVE_URL=http://127.0.0.1:3131
   GBRAIN_CLIENT_ID=...
   GBRAIN_CLIENT_SECRET=...
   # or instead of the client pair:
   # GBRAIN_API_TOKEN=...
   ```

4. `$HERMES_HOME/config.yaml`:

   ```yaml
   memory:
     provider: gbrain
     gbrain:
       readOnly: true        # flip to false to enable the write path
       contextChars: 1200    # recall budget (chars)
       recallLimit: 5
       entityTag: ""         # optional tag added to captured pages
   ```

## Budget guidance

`contextChars: 1200` (~300 tokens) is tuned for small local models
(Qwen3-4B class). For cloud-model sessions bump to ~`4000`. Truncation is
word-boundary safe and the result is always ≤ the budget.

## Env vars

| Var | Purpose |
|---|---|
| `GBRAIN_SERVE_URL` | Base URL of `gbrain serve --http` (also `memory.gbrain.baseUrl`) |
| `GBRAIN_CLIENT_ID` / `GBRAIN_CLIENT_SECRET` | OAuth 2.1 client_credentials |
| `GBRAIN_API_TOKEN` | Static bearer token (takes precedence) |
| `GBRAIN_BUN`, `GBRAIN_DIR`, `GBRAIN_HOME` | Honored by the CLI fallback path |

## Operation mapping

| Provider action | gbrain op | Notes |
|---|---|---|
| `prefetch` / `gbrain_recall` | `query` (server-exposed, read scope) | semantic search over the token's source scope; NOTE: `query` has no world/private filter (only the facts `recall` op filters remote callers to `visibility='world'`) |
| `gbrain_capture` / session summaries | `put_page` (write scope) | there is no server `capture` op; tags ride in YAML frontmatter; CLI fallback `gbrain capture --stdin` if the server refuses. No `visibility` frontmatter is written — gbrain (≤0.41.x) ignores page-frontmatter visibility and facts extracted from pages default to `private` |
| `gbrain_forget` | `forget_fact` (write scope) | numeric fact id; CLI fallback `gbrain forget <id>` |

All three primary ops are server-exposed (`server_ok`), so the CLI
fallback (subprocess, argument-list only) only triggers on an
`unknown_operation`-style refusal from an older daemon.

## Behavior notes

- `prefetch` never blocks a turn: ≤3s timeout, empty string on any error.
- Output is plain text — the MemoryManager adds the `<memory-context>`
  fences; the provider strips any fence markup found in stored pages.
- `sync_turn` is a no-op in v1 (PRD D2: no automatic per-turn writes).
- Rollback: set `memory.provider: builtin` and restart the gateway.
