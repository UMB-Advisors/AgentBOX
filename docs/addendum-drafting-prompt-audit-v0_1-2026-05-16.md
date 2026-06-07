# Addendum — Drafting prompt audit (live state, 2026-05-16)

**Status:** STAQPRO-357 sub-task 1
**Carved from:** STAQPRO-341 (PR #81 merged 2026-05-14)
**Consumed by:** STAQPRO-342 (T2 three-way bake-off) — fair-baseline evidence
**Boxes audited:** M1 (`mailbox.heronlabsinc.com`, `192.168.50.179`), M2 (`mailbox.staqs.io`, `192.168.50.11`)
**Workflow JSONs:** byte-identical between M1 and M2 (`diff` returns empty on the `MailBOX-Draft.nodes` column). One audit covers both boxes.

## TL;DR — the three questions

| Question | Answer | Evidence |
|---|---|---|
| Is the **persona overlay** (§5.4) injected today? | **YES.** Operator-override → extraction-derived → hardcoded-neutral chain via `getPersonaContext('default')`, lands in `buildSystemPrompt` | M1 `mailbox.persona['default']` populated; live system message starts with `"You are an email assistant for Heron Labs team at Heron Labs — a small-batch CPG (gummies + functional confections) operator."` |
| Is **thread history** included? | **YES (since PR #81, 2026-05-14).** `getThreadHistory` walks `thread_id` across `inbox_messages` ∪ `sent_history`, strips quoting per-message, caps at `THREAD_HISTORY_CHAR_BUDGET=6000` chars (~1500 tokens). LOCAL: always. CLOUD: gated by `RAG_CLOUD_ROUTE_ENABLED`. Renders into `assemblePrompt → threadBlock` (further capped to `MAX_THREAD_CHARS=2000c`). | Live execution 8345 (M1, `MailBOX-Draft`, 2026-05-16 01:16 UTC) user-prompt contains a `## Prior thread context` block with 8 prior messages |
| Are **few-shot examples** present? | **Plumbing YES, data effectively NO.** `getCategoryExemplars(category, k=1, 'default')` runs on every draft and is wired into `exemplarBlock` (header: `"## Past replies you've sent for this kind of message"`). But it queries `mailbox.sent_history` which on M1 has only 444 rows: `unknown=441`, `reorder=2`, `escalate=1`, everything else `0`. → `inquiry`/`internal`/`follow_up`/`scheduling` exemplars are not firing in production. Sub-task 2 of STAQPRO-357 addresses this. | M1 last 20 drafts: `ex_n=1` on 2 cloud `unknown` drafts (IDs 142, 151); `ex_n=0` on the other 18 |

## 1. n8n side — `MailBOX-Draft` workflow

`MailBOX-Draft` is **thin** — it has no prompt body. It's a 5-node pass-through that defers all prompt assembly to `dashboard/app/api/internal/draft-prompt/route.ts` (the LLM-bound `messages` array arrives **already-assembled** from the dashboard).

Five nodes (identical on M1 and M2):

| # | Node | Type | Role |
|---|---|---|---|
| 1 | `When Called by Classify` | `executeWorkflowTrigger` | Entry point from `MailBOX-Classify` with `{ draft_id }` |
| 2 | `Get Prompt` | `httpRequest` | POST `http://mailbox-dashboard:3001/dashboard/api/internal/draft-prompt` with `{ draft_id }`, receives `{ baseUrl, apiKey, model, source, display_label, messages, max_tokens, temperature }` |
| 3 | `Mark Start` | `set` | Pins the response fields onto the workflow item for downstream nodes |
| 4 | `Call LLM` | `httpRequest` | POST `{baseUrl}/api/chat` with the `messages` array, model, temperature, num_predict |
| 5 | `Finalize Draft` | `httpRequest` | POST `http://mailbox-dashboard:3001/dashboard/api/internal/draft-finalize` with `{ draft_id, body, source, model, input_tokens, output_tokens }` |

### Node bodies — verbatim (extracted 2026-05-16 from `workflow_entity.nodes`)

#### `Get Prompt`

```json
{
  "method": "POST",
  "url": "http://mailbox-dashboard:3001/dashboard/api/internal/draft-prompt",
  "sendBody": true,
  "specifyBody": "json",
  "jsonBody": "={\n  \"draft_id\": {{ Number($json.draft_id) }}\n}",
  "options": { "timeout": 5000 }
}
```

#### `Mark Start` (set node — pins endpoint config + assembled messages onto the item)

```
assignments:
  draft_id        ← Number($json.draft_id)
  baseUrl         ← $json.baseUrl
  apiKey          ← $json.apiKey || ''
  model           ← $json.model
  source          ← $json.source
  display_label   ← $json.display_label
  messages        ← $json.messages       (already-assembled chat-completions array)
  max_tokens      ← Number($json.max_tokens)
  temperature     ← Number($json.temperature)
  started_at_ms   ← $now.toMillis()
```

#### `Call LLM`

```json
{
  "method": "POST",
  "url": "={{ $('Mark Start').item.json.baseUrl }}/api/chat",
  "sendBody": true,
  "specifyBody": "json",
  "jsonBody": "={\n  \"model\": {{ JSON.stringify($('Mark Start').item.json.model) }},\n  \"messages\": {{ JSON.stringify($('Mark Start').item.json.messages) }},\n  \"stream\": false,\n  \"options\": {\n    \"temperature\": {{ Number($('Mark Start').item.json.temperature) }},\n    \"num_predict\": {{ Number($('Mark Start').item.json.max_tokens) }}\n  }\n}",
  "sendHeaders": true,
  "specifyHeaders": "json",
  "jsonHeaders": "={\n  \"Authorization\": {{ JSON.stringify('Bearer ' + ($('Mark Start').item.json.apiKey || 'local')) }}\n}",
  "options": { "timeout": 90000 }
}
```

> Both LOCAL and CLOUD routes hit this same node — the dashboard's `pickEndpoint(category, confidence)` (in `dashboard/lib/drafting/router.ts`) returns the appropriate `baseUrl` + `apiKey` + `model` per call. Ollama Cloud and the local Ollama / llama-cpp proxy all speak the same `/api/chat` envelope.

#### `Finalize Draft`

```json
{
  "method": "POST",
  "url": "http://mailbox-dashboard:3001/dashboard/api/internal/draft-finalize",
  "sendBody": true,
  "specifyBody": "json",
  "jsonBody": "={\n  \"draft_id\": {{ Number($('Mark Start').item.json.draft_id) }},\n  \"body\": {{ JSON.stringify($json.message && $json.message.content ? $json.message.content : '') }},\n  \"source\": {{ JSON.stringify($('Mark Start').item.json.source) }},\n  \"model\": {{ JSON.stringify($('Mark Start').item.json.model) }},\n  \"input_tokens\": {{ Number($json.prompt_eval_count || 0) }},\n  \"output_tokens\": {{ Number($json.eval_count || 0) }}\n}",
  "options": { "timeout": 5000 }
}
```

## 2. Dashboard side — `/api/internal/draft-prompt` prompt assembly

The real prompt lives in `dashboard/lib/drafting/prompt.ts:assemblePrompt`. Composed from:

- **System message** — `buildSystemPrompt(persona)`:
  - Operator framing line: `"You are an email assistant for {operator_first_name} at {operator_brand} — a {business_description}."` (fully persona-driven post CPG-scrub Phase 1 / 2026-05-08)
  - Voice line: `"You draft replies in their voice: {tone}."` (default fallback `"concise, direct, warm — short paragraphs, no corporate hedging"`)
  - `"You are NOT a chatbot. The operator reviews every draft before it sends, so be specific, useful, and short."`
  - Sign-off line: `"Sign off with: {signoff}"`
  - `"Never mention that you are an AI."`
  - **Critical placeholder block** — 8 explicit lines + 3 BAD/GOOD example pairs (MOQ, lead time, ship date) instructing the model to leave `[confirm with operator: ...]` brackets rather than invent facts. Burns ~150 tokens; per the in-code comment, "the 4B local model follows abstract instructions only ~50% of the time but mimics concrete examples reliably."

- **User message** — `buildUserPrompt(input)`:
  1. `/no_think` directive (Qwen3-instruct ignores it harmlessly; cloud models also ignore; `normalizeDraftBody` strips any residual `<think>` blocks defensively)
  2. Classification line: `"Classification: {category} ({confidence}% confidence) — {CATEGORY_DESCRIPTIONS[category]}"`
  3. `"Draft a reply to this email. Match the operator's voice from the system prompt."`
  4. `## Inbound email` block — From / To / Subject, then body (capped at `MAX_BODY_CHARS=6000`). Body is **pre-stripped** by `stripQuotedAndSignature` (STAQPRO-341) before this point.
  5. `threadBlock(input)` — `## Prior thread context`. Walks `thread_context[]` newest-first, per-message `From: …` header + body (truncated to 800c each). Halts when `MAX_THREAD_CHARS=2000` is consumed.
  6. `exemplarBlock(input)` — `## Past replies you've sent for this kind of message`. Up to 2 entries (caller passes `k=1`); each labeled with the send date + subject. Per-snippet cap = `RAG_RETRIEVE_EXCERPT_CHARS=600` chars.
  7. `ragBlock(input)` — `## Reference snippets (use only if relevant)`. Cap is `2` when exemplars present, `3` otherwise (`effectiveRagRefsCap`); each ref is `[source] excerpt-up-to-600c`.
  8. `kbBlock(input)` — `## Reference snippets from your knowledge base`. Up to 3 entries from operator-uploaded SOPs (STAQPRO-148); each `[source] excerpt-up-to-600c`.
  9. `## Output format` — `"Return ONLY the body of the reply email. No subject line, no headers, no quoted original. Plain text only."`

### `assemblePrompt` returns

```ts
{
  messages: [
    { role: 'system', content: buildSystemPrompt(persona) },
    { role: 'user',   content: buildUserPrompt(input) }
  ],
  max_tokens: 600,
  temperature: 0.7,
}
```

### Block order rationale (STAQPRO-234 / commit b88a9e1)

Exemplars come **before** RAG + KB inside the user prompt. The in-code comment: "the LLM anchors on the operator's own voice from prior replies before reading the conversational RAG / KB reference snippets."

### Token budget (DR-18, Qwen3-4B 4096 ctx)

Augmentation slice ~450 tokens:

- With exemplars present: 1 exemplar (~150 tok) + 2 RAG refs (~300 tok) = ~450
- Without exemplars: 3 RAG refs (~450 tok)
- Thread history shares the existing `MAX_THREAD_CHARS=2000c` slot in `threadBlock` — does NOT add to the augmentation slice
- KB refs add up to 3 × 600c = ~450 tok when present (operator-controlled — not part of the default budget calc)

### Privacy gate matrix

| Slot | LOCAL route | CLOUD route |
|---|---|---|
| Persona | always | always |
| Thread history (`thread_context`) | always | gated by `RAG_CLOUD_ROUTE_ENABLED=1` |
| Exemplars (`exemplar_refs`) | always (data permitting) | always (data permitting) |
| RAG refs (`rag_refs`) | always | gated by `RAG_CLOUD_ROUTE_ENABLED=1` |
| KB refs (`kb_refs`) | always | gated by `RAG_CLOUD_ROUTE_ENABLED=1` |

Per the project Constraints: "All email content stored only on local appliance. No bulk corpus sent to cloud." `RAG_CLOUD_ROUTE_ENABLED` is the operator's opt-in lever.

## 3. Live execution capture — M1 exec 8345 (2026-05-16 01:16 UTC, `follow_up`, LOCAL llama-cpp)

This is what actually crossed the wire from `Get Prompt → Mark Start → Call LLM` on customer #1, ~2h before this audit was written. Captured from `execution_data.data` (n8n's marshalled execution log).

### System message (verbatim, first ~600 chars)

```
You are an email assistant for Heron Labs team at Heron Labs — a small-batch CPG (gummies + functional confections) operator.
You draft replies in their voice: concise, direct, warm — short paragraphs, no corporate hedging.
You are NOT a chatbot. The operator reviews every draft before it sends, so be specific, useful, and short.
Sign off with: — Heron Labs
Never mention that you are an AI.

CRITICAL — when you do not know a fact, leave a bracketed placeholder.
Do not invent prices, minimums, lead times, capabilities, or commitments.
Use [confirm with operator: <what to confirm>] inline. Examples:
  ✗ BAD:  ...
```

→ **Persona overlay live and operator-tuned**: `operator_first_name = "Heron Labs team"`, `operator_brand = "Heron Labs"`, `business_description = "small-batch CPG (gummies + functional confections) operator"`, `tone = "concise, direct, warm — short paragraphs, no corporate hedging"`, `signoff = "— Heron Labs"`.

### User message (structural — what blocks actually appeared)

For this `follow_up` execution:

| Block | Present | Notes |
|---|---|---|
| `/no_think` | yes | First line |
| Classification line | yes | `Classification: follow_up (95% confidence) — Continuation of a prior thread the recipient was already engaged in.` |
| `## Inbound email` | yes | 1-line body (`Awesome I'm so excited about this! How did they taste?`) |
| `## Prior thread context` | yes | **8 prior messages** from `jt@heronlabsinc.com`, `dylan@voidsleep.us`, `eddie@heronlabsinc.com` — exactly the PR #81 thread-history walker output |
| `## Past replies you've sent for this kind of message` | no | M1 has zero `follow_up` rows in `sent_history` — exemplar empty as predicted |
| `## Reference snippets (use only if relevant)` | no | RAG retrieval returned 0 hits for this counterparty + thread combination |
| `## Reference snippets from your knowledge base` | yes | **3 snippets** from `White Label Manufacturing and Intellectual Property Agreement – Updated 3.18.26.docx` (operator-uploaded SOP) |
| `## Output format` | yes | Trailing instruction |

→ Confirms thread-history (PR #81) and KB-refs (STAQPRO-148) are both live and firing on production traffic. Exemplar slot is wired but empty for `follow_up` due to the sent_history data gap (see TL;DR row 3).

## 4. Findings for the bake-off (STAQPRO-342)

1. **The PR #81 prompt is the bake-off baseline.** All three candidate models (Nemotron 4B, Qwen3.5-4B, Gemma 4 E4B) will receive the same assembled `messages` array — the only variable is the model weights + their Modelfile params. Routing (`pickEndpoint`) is category-driven, not model-driven, so swapping the local model is a `DRAFT_LOCAL_MODEL` constant change plus `LOCAL_INFERENCE_RUNTIME` selection.

2. **The exemplar slot is empty for the categories most likely to show local-model improvement**: `inquiry`, `internal`, `follow_up`, `scheduling`. Until sub-task 2 lands a seed, the bake-off can only compare "model behavior **without** the exemplar boost." This is a fair comparison among models but **understates** the production capability of the winner. → **Recommendation**: seed before bake-off, per the issue's own sequencing note ("Steps 1 + 2 should land **before** the bake-off runs").

3. **PR #81 vs DR-25 cutover confounded in the same window.** Both landed on 2026-05-14 PDT on M1. A clean PR #81 A/B (sub-task 3) cannot use post-cutover drafts as the "post" arm without disentangling. The `model` column discriminates: `qwen3:4b-ctx4k` (with colon) = Ollama path; `qwen3-4b-ctx4k` (no colon) = llama-cpp path. Sub-task 3 documents this in the Linear thread.

4. **Cloud and local share the same prompt**. The cloud path doesn't get extra context, system instructions, or examples. Local Qwen3-4B is on a fair footing prompt-wise — any quality gap is genuinely the model, not the scaffolding.

## 5. Source references

- Prompt assembly: `dashboard/lib/drafting/prompt.ts` (D-41 single-source-of-truth)
- Route entry: `dashboard/app/api/internal/draft-prompt/route.ts`
- Routing: `dashboard/lib/drafting/router.ts` (DR-25 amend 2026-05-13)
- Persona: `dashboard/lib/drafting/persona.ts` (STAQPRO-195)
- Thread history: `dashboard/lib/drafting/thread-history.ts` (STAQPRO-341, PR #81)
- Quote stripping: `dashboard/lib/drafting/strip-quoting.ts` (STAQPRO-341, PR #81)
- Exemplars: `dashboard/lib/drafting/exemplars.ts` (STAQPRO-234, KB Phase 1)
- KB ingestion: `dashboard/lib/rag/retrieve.ts` `:kb_refs` branch (STAQPRO-148)
- n8n workflow: `n8n/workflows/MailBOX-Draft.json` (5 nodes, byte-identical M1 ≡ M2)
- Live capture: M1 execution_entity id 8345, 2026-05-16 01:16:09 UTC

## 6. What this addendum is NOT

- Not a code change. STAQPRO-357 is operator actions only.
- Not a tuning recommendation. STAQPRO-342's eval scores drive tuning; this doc gives the bake-off its fair-baseline anchor.
- Not exhaustive — the operator/onboarding-uploaded `category_exemplars` jsonb column on `mailbox.persona` is a **wired-but-not-read** surface today: `getCategoryExemplars` reads only from `mailbox.sent_history`, not from `persona.category_exemplars`. Hand-curation via that column is unwired (STAQPRO-149 not yet in flight on the read path). Sub-task 2 has to seed `sent_history` directly (or extend the read path via a separate ticket).
