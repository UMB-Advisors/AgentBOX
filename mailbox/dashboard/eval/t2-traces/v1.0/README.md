# T2 Eval Trace Set v1.0

> **Status:** v1.0 (draft-reply only). v1.1 long-context tier + the other three workflow categories (`classify-and-file`, `summarize-thread`, `escalate-to-human`) tracked under STAQPRO-340.1 / STAQPRO-340.2.
>
> **What this is:** the eval harness corpus for STAQPRO-342 (three-way model bake-off), STAQPRO-343 (DSPy GEPA optimizer), and STAQPRO-344 (per-customer LoRA validation). A frozen point-in-time snapshot of `(inbound email, human-written reply)` pairs from a live appliance, used as a stable benchmark so multiple model variants can be compared on identical inputs.

## Privacy contract

**The actual `*.trace.json` files are NOT committed to this repo.** They contain real customer-#1 email bodies — even PII-scrubbed (phone, SSN, 16-digit-card → tokens via `dashboard/lib/rag/scrub.ts`), email addresses, URLs, and names remain intact for retrieval signal per the STAQPRO-193 locked decision. The project's privacy constraint ("All email content stored only on local appliance") rules out checking JSONL into a public-or-publishable repo.

What IS committed:

- `manifest.example.json` — schema reference (synthetic placeholder traces, no real customer data).
- `README.md` — this file.
- `.gitignore` (in `dashboard/eval/`) — excludes `*.trace.json` and the operator-generated `manifest.json`.
- The export tooling lives at `dashboard/scripts/build-trace-set.ts` and the shared types at `dashboard/lib/eval/trace-set.ts`.

What does NOT get committed:

- `*.trace.json` — real trace data.
- `manifest.json` — operator-generated against real traces; the SHA-256 in this manifest is your reproducibility anchor and is fine to share in Linear / PR comments (the hash leaks no content).

The operator regenerates the JSONL on their workstation from the live appliance DB before running the eval. See "Regenerate" below.

## Format (v1.0)

Each `*.trace.json` is a single canonical-JSON document with these fields (full schema in `dashboard/lib/eval/trace-set.ts:traceSchema`):

```jsonc
{
  "format_version": "v1",
  "workflow_category": "draft-reply",     // v1.0 emits this only
  "classification": "inquiry",            // live qwen3 category at curation time
  "inbox_message_id": "<gmail-msg-id>",   // stable across reruns
  "inbox_thread_id": "<gmail-thread-id>", // drives RAG H3 same-thread suppression
  "inbox_from": "alice@example.com",      // bare addr (no display name)
  "inbox_subject": "subject text",        // not scrubbed
  "inbox_body": "...[REDACTED:phone]...", // scrubbed via lib/rag/scrub.ts
  "inbox_confidence": 0.92,               // classifier confidence at curation time
  "actual_reply_body": "...",             // PII-scrubbed; the human-curated preferred output
  "reply_sent_at": "2026-03-14T...",
  "provenance": {
    "appliance": "mailbox1",
    "sent_history_id": 412,
    "inbox_id": 938,
    "extracted_at": "2026-05-13T...",
    "scrub_counts": { "phone": 1, "ssn": 0, "card": 0 }
  }
}
```

Canonical JSON: keys are emitted alphabetically by the build script's `traceToCanonicalJson()` so byte-for-byte SHA-256s are stable across machines + Node versions. **Do not hand-edit a trace file** — that breaks the manifest's per-trace SHA, and the harness refuses to run on a tampered set.

The filename is `<first-16-hex-of-trace-sha256>.trace.json`. Two traces with identical bytes produce identical filenames (which the build script asserts can't happen on real data via the `inbox_message_id` dedup).

## Manifest

`manifest.json` (operator-generated, gitignored) binds the set:

```jsonc
{
  "format_version": "v1",
  "set_version": "v1.0",
  "generated_at": "2026-05-13T05:00:00Z",
  "source_appliance": "mailbox1",
  "count": 50,
  "set_sha256": "<64-hex-chars>",        // SHA over sorted concat of per-trace SHAs
  "entries": [
    {
      "filename": "<16-hex>.trace.json",
      "inbox_message_id": "<gmail-msg-id>",
      "workflow_category": "draft-reply",
      "classification": "inquiry",
      "trace_sha256": "<64-hex-chars>"
    },
    // ... one entry per trace, sorted by inbox_message_id
  ]
}
```

The `set_sha256` is the **single number** to cite in a Linear comment or a bake-off result table — it's a content-address for the entire eval input. Two runs with the same `set_sha256` were evaluated on byte-identical traces.

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
    --out eval/t2-traces/v1.0 \
    --set-version v1.0 \
    --appliance mailbox1 \
    --limit 50 \
    --clean

# 4. Tear down the tunnel.
kill $TUNNEL_PID
```

The script will print `set_sha256=<hex>` on success. Compare against the value cited in the bake-off PR / Linear comment to confirm you're evaluating the same input.

## Run the eval against the trace set

After regeneration:

```bash
cd dashboard
POSTGRES_URL=<unused-but-required-for-perms-on-old-routes> \
OLLAMA_BASE_URL=http://ollama:11434 \
QDRANT_URL=http://qdrant:6333 \
  npx tsx scripts/rag-eval-harness.ts \
    --trace-set eval/t2-traces/v1.0 \
    --judge=haiku \
    --run-tag eval-qwen3-4b-ctx4k-2026-05-13-baseline
```

The harness loads from disk, verifies the manifest SHA, and runs the standard cosine + judge + perf-metrics path. Output lands in `dashboard/eval-results/` with the `--run-tag` suffix in the filename so bake-off aggregation can glob.

## Sub-issue tracking

| Sub-issue | Scope |
|---|---|
| STAQPRO-340.1 | v1.1 long-context (8K / 16K) trace tier. Blocked on assembling 8K+ email-thread inputs (current customer-#1 corpus rarely hits 8K in a single inbound). |
| STAQPRO-340.2 | Synthetic / labeled traces for `classify-and-file`, `summarize-thread`, `escalate-to-human` categories. Blocked on operator approval of synthesis strategy. |
| STAQPRO-340.3 | Function-call validity metric. Blocked on the live drafter exposing tool calls. |

Open these as actual Linear sub-issues from the PR once it merges.
