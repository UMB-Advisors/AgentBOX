# T2 Eval Trace Set v1.1

> **Status:** v1.1 (draft-reply only). Supersedes v1.0 for all new eval / bake-off / optimizer runs.
>
> **What this is:** the v1.0 trace set re-extracted from the same live appliance with two corpus-quality filters layered onto `buildSourceSql`. v1.0 stays around for historical comparison, but **all new STAQPRO-342 / STAQPRO-343 / STAQPRO-344 runs should target v1.1**.

## What changed v1.0 → v1.1 (STAQPRO-365)

v1.0 emitted every row of `sent_history JOIN inbox_messages` as a trace, with no quality filtering. Two problems surfaced in the STAQPRO-343 Run-1 baseline (2026-05-14):

1. **Forwarded messages were emitted as "operator replies."** When the operator forwarded an inbound (e.g. internal team distribution) instead of replying, `sent_history.draft_sent` was the forwarded-chain body (`---------- Forwarded message --------- From: …`). The GEPA judge then scored real candidate drafts against forwarded boilerplate — useless training signal.
2. **Duplicate-inbound rows.** When the operator replied to (or forwarded then replied to) the same inbound multiple times, the same `inbox_message_id` appeared in N traces with different `actual_reply_body` values. A deterministic target model produces one candidate per prompt, so the metric scored a single candidate against multiple "ground truths" — diluting signal.

v1.1 addresses both:

| Change | How | Bias |
|---|---|---|
| Drop forwarded / quote-block rows | `WHERE SUBSTRING(sh.draft_sent FROM 101) !~ '<forwarded_regex>'` — looks for `---`, `On <day>, <person> wrote:`, or `>` quote markers **after** the first 100 chars of the body. The 100-char offset prevents false positives on real replies that happen to open with `---` then continue with real content. | False negatives OK (some forwards leak through and get filtered as duplicates instead); false positives BAD (real replies dropped). |
| Dedupe to one canonical reply per inbound | `SELECT DISTINCT ON (inbox_id) ... ORDER BY inbox_id, is_forwarded_head ASC, body_len DESC, reply_sent_at ASC, sent_history_id ASC` — non-forwarded head wins over forwarded, longest body wins, earliest reply wins, then sent_history_id as a final stability tiebreak. | Deterministic across re-runs. |

Schema is **unchanged** — `Trace`, `TraceManifest`, `traceSchema` in `dashboard/lib/eval/trace-set.ts` are byte-identical to v1.0. `TRACE_FORMAT_VERSION` stays at `'v1'`. Only the source filter changed.

The forwarded regex is exported as `FORWARDED_BODY_REGEX_SQL` from `dashboard/scripts/build-trace-set.ts` and asserted against fixtures in `dashboard/test/scripts/build-trace-set.test.ts`.

## Expected trace count delta

Re-running against the customer-#1 corpus (~100 v1.0 rows) is expected to yield roughly **70-80 v1.1 traces**:

- Drop ~10-20% for forwarded-chain bodies (depends on how often the operator forwards vs. replies).
- Drop additional duplicates where `inbox_message_id` collisions exist after the forward filter.

Run-1 figures are tracked in the STAQPRO-365 PR description and Linear comment.

## Privacy contract

Identical to v1.0 — `*.trace.json` files are NOT committed (real customer email bodies, PII-scrubbed but not anonymized). Only `manifest.example.json` (synthetic) + this README + `.gitignore` are checked in. See [`../v1.0/README.md`](../v1.0/README.md) "Privacy contract" for the full reasoning.

## Format

Unchanged from v1.0 — see [`../v1.0/README.md`](../v1.0/README.md) "Format (v1.0)" for the field list. The on-disk schema is the same; `manifest.json` carries `"set_version": "v1.1"` to distinguish from v1.0.

## Manifest

Identical to v1.0 manifest schema. The `set_sha256` value will differ — that's the point. Cite the v1.1 `set_sha256` in any Linear comment or eval-results PR.

## Regenerate

From a workstation with SSH to the source appliance and the dashboard container available:

```bash
# 1. Open an SSH tunnel to the appliance Postgres.
ssh -L 5432:localhost:5432 mailbox1 -N &
TUNNEL_PID=$!

# 2. Look up the appliance Postgres password from 1Password.
APPLIANCE_PASSWORD=$(op item get 'mailbox1' --vault MailBOX --reveal --fields password)

# 3. Run the build script. Pin `--extracted-at` to get byte-identical re-runs.
cd dashboard
POSTGRES_URL="postgresql://mailbox:${APPLIANCE_PASSWORD}@localhost:5432/mailbox" \
  npx tsx scripts/build-trace-set.ts \
    --out eval/t2-traces/v1.1 \
    --set-version v1.1 \
    --appliance mailbox1 \
    --limit 100 \
    --clean

# 4. Tear down the tunnel.
kill $TUNNEL_PID
```

Or, run directly inside the dashboard container on the appliance (no tunnel needed):

```bash
ssh mailbox1 'docker exec mailbox-dashboard sh -c "cd /app && POSTGRES_URL=\$POSTGRES_URL \
  npx tsx scripts/build-trace-set.ts \
    --out eval/t2-traces/v1.1 \
    --set-version v1.1 \
    --appliance mailbox1 \
    --limit 100 \
    --clean"'
```

The script prints `set_sha256=<hex>` on success. Compare against the value cited in the bake-off PR / Linear comment.

## Run the eval against v1.1

```bash
cd dashboard
POSTGRES_URL=<unused-but-required-for-perms-on-old-routes> \
OLLAMA_BASE_URL=http://ollama:11434 \
QDRANT_URL=http://qdrant:6333 \
  npx tsx scripts/rag-eval-harness.ts \
    --trace-set eval/t2-traces/v1.1 \
    --judge=haiku \
    --run-tag eval-qwen3-4b-ctx4k-2026-05-15-v1_1
```

## Validation

After regeneration, spot-check 10 traces:

- No `---------- Forwarded message ---------` chains in `actual_reply_body`.
- No `On <date>, <person> wrote:` quote blocks dominating the reply.
- Each `inbox_message_id` appears at most once across the set.
- `optimization/dspy/trace_set.py:load_trace_set(directory)` round-trips the v1.1 manifest without raising `TraceSetLoadError`.

## Sub-issue tracking

Same sub-issue list as v1.0 (STAQPRO-340.1 / .2 / .3) — those are orthogonal to the v1.0 → v1.1 filter delta.
