---
status: SUPERSEDED
superseded_by: 02-05-rag-ingest-retrieval-PLAN-v2-2026-04-27-STUB.md (authoritative for architectural intent until promoted to a full v2 plan)
supersession_date: 2026-04-27
supersession_reason: 2026-04-27 Next.js full-stack ADR retired the Express backend layout (`dashboard/backend/src/rag/...`, `dashboard/backend/src/routes/kb.ts`) this plan targets in favor of `dashboard/lib/rag/...` modules and `dashboard/app/api/kb/...` route handlers. See ADR in `.planning/STATE.md` and the v2 STUB for the rescoped architecture.
plan_number: 02-05
slug: rag-ingest-retrieval
wave: 3
depends_on: [02-02]
autonomous: false
requirements: [RAG-01, RAG-02, RAG-03, RAG-04, RAG-05, RAG-06]
files_modified:
  - dashboard/backend/src/rag/client.ts
  - dashboard/backend/src/rag/chunk.ts
  - dashboard/backend/src/rag/embed.ts
  - dashboard/backend/src/routes/kb.ts
  - dashboard/backend/src/index.ts
  - n8n/workflows/06-rag-ingest-sent-history.json
  - n8n/workflows/07-rag-index-new-message.json
---

<objective>
Build the retrieval-augmented generation pipeline: nomic-embed-text v1.5 embeddings, a single Qdrant collection, HTTP-based upsert/search via n8n (since n8n has no first-class Qdrant node), per-email chunking for sent history, per-paragraph chunking for uploaded PDF/DOCX/CSV documents, a dashboard backend `/api/kb` route for document upload/list/delete, a similarity threshold of 0.72 per RAG-05, and top-5 retrieval with the top-3 refs eventually threaded into the drafting sub-workflow (Plan 02-07 consumes this). The 6-month sent history ingest runs as an n8n sub-workflow triggered during onboarding (Plan 02-08 invokes it).
</objective>

<must_haves>
- Qdrant collection `mailbox_rag` exists with `size=768` vectors (nomic-embed-text dim), `distance=Cosine`, and payload fields `source` (`sent_email` | `inbound_email` | `document`), `source_id`, `text`, `meta` (jsonb)
- `POST /api/kb/documents` accepts a PDF/DOCX/CSV upload, chunks it by paragraph, embeds each chunk, and upserts into Qdrant with `source='document'`
- `GET /api/kb/documents` returns all uploaded documents with chunk counts
- `DELETE /api/kb/documents/:id` removes all vectors with the given `source_id`
- `06-rag-ingest-sent-history` workflow ingests 6 months of sent email from the connected account (IMAP `Sent Mail` folder), chunks one-email-per-chunk, embeds, and upserts with `source='sent_email'`. Progress is written to `mailbox.onboarding.ingest_progress_*` for the dashboard to display
- `07-rag-index-new-message` workflow indexes every inbound+sent message after ingestion is live (RAG-03 incremental index)
- A helper function in the drafting workflow (Plan 02-07 will call it) performs vector search with `score_threshold=0.72` and returns the top-3 refs + scores
- The sub-workflow is invoked from the onboarding flow (Plan 02-08) with `{ customer_key }` input
</must_haves>

<tasks>

<task id="1">
<action>
Create `dashboard/backend/src/rag/client.ts` — Qdrant REST client wrapper that ensures the collection exists on startup and exposes `upsert`, `search`, `deleteBySourceId`:

```ts
import { QdrantClient } from '@qdrant/js-client-rest';
import { config } from '../config.js';

export const COLLECTION = 'mailbox_rag';
export const EMBED_DIM = 768; // nomic-embed-text v1.5

export const qdrant = new QdrantClient({ url: config.QDRANT_URL });

export async function ensureCollection(): Promise<void> {
  const exists = await qdrant.getCollections().then((r) => r.collections.some((c) => c.name === COLLECTION)).catch(() => false);
  if (exists) return;
  await qdrant.createCollection(COLLECTION, {
    vectors: { size: EMBED_DIM, distance: 'Cosine' },
  });
  // Payload indexes for fast filtering by source / source_id
  await qdrant.createPayloadIndex(COLLECTION, { field_name: 'source', field_schema: 'keyword' });
  await qdrant.createPayloadIndex(COLLECTION, { field_name: 'source_id', field_schema: 'keyword' });
}

export interface RagPoint {
  id: string | number;
  vector: number[];
  payload: {
    source: 'sent_email' | 'inbound_email' | 'document';
    source_id: string;
    text: string;
    meta?: Record<string, unknown>;
  };
}

export async function upsertPoints(points: RagPoint[]): Promise<void> {
  if (points.length === 0) return;
  await qdrant.upsert(COLLECTION, { wait: true, points });
}

export interface SearchResult {
  id: string | number;
  score: number;
  payload: RagPoint['payload'];
}

export async function searchTopK(vector: number[], k = 5, threshold = 0.72): Promise<SearchResult[]> {
  const res = await qdrant.search(COLLECTION, { vector, limit: k, score_threshold: threshold, with_payload: true });
  return res.map((r) => ({ id: r.id as string | number, score: r.score, payload: r.payload as RagPoint['payload'] }));
}

export async function deleteBySourceId(sourceId: string): Promise<void> {
  await qdrant.delete(COLLECTION, { filter: { must: [{ key: 'source_id', match: { value: sourceId } }] }, wait: true });
}
```
</action>
<read_first>
  - dashboard/backend/src/config.ts  (QDRANT_URL)
  - CLAUDE.md  (nomic-embed-text 768-dim, Qdrant 1.17.1)
  - .planning/REQUIREMENTS.md  (RAG-04 top-5, RAG-05 0.72 threshold)
</read_first>
<acceptance_criteria>
- `dashboard/backend/src/rag/client.ts` exists
- `grep "COLLECTION = 'mailbox_rag'" dashboard/backend/src/rag/client.ts` matches
- `grep 'EMBED_DIM = 768' dashboard/backend/src/rag/client.ts` matches
- `grep "distance: 'Cosine'" dashboard/backend/src/rag/client.ts` matches
- `grep 'score_threshold = 0.72' dashboard/backend/src/rag/client.ts` matches
- `grep 'export async function upsertPoints' dashboard/backend/src/rag/client.ts` matches
- `grep 'export async function searchTopK' dashboard/backend/src/rag/client.ts` matches
- `grep 'export async function deleteBySourceId' dashboard/backend/src/rag/client.ts` matches
</acceptance_criteria>
</task>

<task id="2">
<action>
Create `dashboard/backend/src/rag/chunk.ts` — two chunking strategies: `chunkEmail(body)` returns a single whole-email chunk (sent-history ingest uses this), `chunkDocument(text)` returns paragraph-level chunks targeting ~800-character windows so each stays within the 2K-token nomic-embed-text context. Handles PDF/DOCX/CSV text extraction via `pdf-parse`, `mammoth`, and a naive CSV-to-text converter.

```ts
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const pdfParse = require('pdf-parse');
const mammoth = require('mammoth');

export function chunkEmail(body: string): string[] {
  const trimmed = (body || '').trim();
  if (!trimmed) return [];
  // Per-email chunking per CONTEXT.md Claude's Discretion — whole email = 1 chunk
  return [trimmed.slice(0, 6000)];
}

export function chunkDocument(text: string): string[] {
  const normalized = (text || '').replace(/\r\n/g, '\n').trim();
  if (!normalized) return [];
  const paragraphs = normalized.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);
  const out: string[] = [];
  let buf = '';
  for (const p of paragraphs) {
    if (!buf) { buf = p; continue; }
    if ((buf.length + p.length + 2) <= 800) buf = `${buf}\n\n${p}`;
    else { out.push(buf); buf = p; }
  }
  if (buf) out.push(buf);
  return out;
}

export async function extractText(filename: string, buf: Buffer): Promise<string> {
  const ext = filename.toLowerCase().split('.').pop();
  if (ext === 'pdf') {
    const res = await pdfParse(buf);
    return String(res.text || '');
  }
  if (ext === 'docx') {
    const res = await mammoth.extractRawText({ buffer: buf });
    return String(res.value || '');
  }
  if (ext === 'csv' || ext === 'txt') {
    return buf.toString('utf8');
  }
  throw new Error(`unsupported file type: .${ext}`);
}
```

Add deps to `dashboard/package.json`: `"pdf-parse": "^1.1.1"`, `"mammoth": "^1.8.0"`.
</action>
<read_first>
  - dashboard/package.json  (add RAG deps)
  - .planning/phases/02-email-pipeline-core/02-CONTEXT.md  (Claude's Discretion: chunking strategy)
  - .planning/REQUIREMENTS.md  (RAG-02 PDF/DOCX/CSV)
</read_first>
<acceptance_criteria>
- `dashboard/backend/src/rag/chunk.ts` exists
- `grep 'export function chunkEmail' dashboard/backend/src/rag/chunk.ts` matches
- `grep 'export function chunkDocument' dashboard/backend/src/rag/chunk.ts` matches
- `grep 'export async function extractText' dashboard/backend/src/rag/chunk.ts` matches
- `grep 'pdf-parse' dashboard/package.json` matches
- `grep 'mammoth' dashboard/package.json` matches
</acceptance_criteria>
</task>

<task id="3">
<action>
Create `dashboard/backend/src/rag/embed.ts` — calls Ollama's `/api/embeddings` endpoint for nomic-embed-text v1.5 and returns a 768-dim vector:

```ts
import { config } from '../config.js';

const MODEL = 'nomic-embed-text:v1.5';

export async function embed(text: string): Promise<number[]> {
  const res = await fetch(`${config.OLLAMA_URL}/api/embeddings`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: MODEL, prompt: text }),
  });
  if (!res.ok) throw new Error(`ollama embed failed: ${res.status}`);
  const j = (await res.json()) as { embedding: number[] };
  if (!Array.isArray(j.embedding) || j.embedding.length !== 768) {
    throw new Error(`unexpected embedding length: ${j.embedding?.length}`);
  }
  return j.embedding;
}

export async function embedMany(texts: string[]): Promise<number[][]> {
  const out: number[][] = [];
  for (const t of texts) out.push(await embed(t)); // serial — Ollama single-worker path is safer on 8GB
  return out;
}
```
</action>
<read_first>
  - dashboard/backend/src/config.ts
  - CLAUDE.md  (nomic-embed-text v1.5 requires Ollama 0.1.26+)
</read_first>
<acceptance_criteria>
- `dashboard/backend/src/rag/embed.ts` exists
- `grep "nomic-embed-text:v1.5" dashboard/backend/src/rag/embed.ts` matches
- `grep 'j.embedding.length !== 768' dashboard/backend/src/rag/embed.ts` matches
- `grep 'export async function embed' dashboard/backend/src/rag/embed.ts` matches
</acceptance_criteria>
</task>

<task id="4">
<action>
Create `dashboard/backend/src/routes/kb.ts` — document upload/list/delete routes:

```ts
import { Router } from 'express';
import multer from 'multer';
import { randomUUID } from 'node:crypto';
import { chunkDocument, extractText } from '../rag/chunk.js';
import { embedMany } from '../rag/embed.js';
import { upsertPoints, deleteBySourceId, qdrant, COLLECTION } from '../rag/client.js';

export const kbRouter = Router();
const upload = multer({ limits: { fileSize: 20 * 1024 * 1024 } });

kbRouter.post('/documents', upload.single('file'), async (req, res) => {
  const file = req.file;
  if (!file) return res.status(400).json({ error: 'no file' });
  try {
    const text = await extractText(file.originalname, file.buffer);
    const chunks = chunkDocument(text);
    if (chunks.length === 0) return res.status(400).json({ error: 'empty after chunking' });
    const vectors = await embedMany(chunks);
    const sourceId = `doc:${randomUUID()}`;
    const points = chunks.map((chunk, i) => ({
      id: `${sourceId}:${i}`,
      vector: vectors[i],
      payload: {
        source: 'document' as const,
        source_id: sourceId,
        text: chunk,
        meta: { filename: file.originalname, chunk_index: i, uploaded_at: new Date().toISOString() },
      },
    }));
    await upsertPoints(points);
    res.status(201).json({ source_id: sourceId, chunks: chunks.length, filename: file.originalname });
  } catch (e) {
    res.status(500).json({ error: (e as Error).message });
  }
});

kbRouter.get('/documents', async (_req, res) => {
  // Scroll payload records filtered by source='document', aggregate by source_id
  const out: Record<string, { source_id: string; filename: string; chunk_count: number; uploaded_at?: string }> = {};
  let offset: string | number | null = null;
  do {
    const page: any = await qdrant.scroll(COLLECTION, {
      filter: { must: [{ key: 'source', match: { value: 'document' } }] },
      limit: 256,
      with_payload: true,
      offset: offset ?? undefined,
    });
    for (const p of page.points) {
      const sid = p.payload?.source_id as string;
      if (!out[sid]) {
        out[sid] = {
          source_id: sid,
          filename: String(p.payload?.meta?.filename || 'unknown'),
          chunk_count: 0,
          uploaded_at: p.payload?.meta?.uploaded_at,
        };
      }
      out[sid].chunk_count += 1;
    }
    offset = page.next_page_offset;
  } while (offset);
  res.json({ documents: Object.values(out) });
});

kbRouter.delete('/documents/:sourceId', async (req, res) => {
  await deleteBySourceId(req.params.sourceId);
  res.status(204).end();
});
```

Add `multer` to `dashboard/package.json` dependencies: `"multer": "^1.4.5-lts.1"` plus `"@types/multer": "^1.4.11"` under devDependencies.

Wire the router into `dashboard/backend/src/index.ts`:

```ts
// Add at the top with other imports:
import { kbRouter } from './routes/kb.js';
import { ensureCollection } from './rag/client.js';

// After healthRouter:
app.use('/api/kb', kbRouter);

// Before server.listen, add:
ensureCollection().catch((e) => console.error('[rag] ensureCollection failed', e));
```
</action>
<read_first>
  - dashboard/backend/src/rag/client.ts
  - dashboard/backend/src/rag/chunk.ts
  - dashboard/backend/src/rag/embed.ts
  - dashboard/backend/src/index.ts  (wire router)
  - .planning/REQUIREMENTS.md  (RAG-02, RAG-06)
</read_first>
<acceptance_criteria>
- `dashboard/backend/src/routes/kb.ts` exists
- `grep "kbRouter.post('/documents'" dashboard/backend/src/routes/kb.ts` matches
- `grep "kbRouter.get('/documents'" dashboard/backend/src/routes/kb.ts` matches
- `grep "kbRouter.delete('/documents/:sourceId'" dashboard/backend/src/routes/kb.ts` matches
- `grep '/api/kb' dashboard/backend/src/index.ts` matches
- `grep 'ensureCollection' dashboard/backend/src/index.ts` matches
- `grep '"multer"' dashboard/package.json` matches
</acceptance_criteria>
</task>

<task id="5">
<action>
Create `n8n/workflows/06-rag-ingest-sent-history.json` — onboarding-time sub-workflow. Triggered via Execute Workflow with `{ customer_key, months_back: 6 }`. Node graph:

1. **Execute Workflow Trigger** — accepts `{ customer_key, months_back }`.
2. **Postgres: Set onboarding to ingesting** — `UPDATE mailbox.onboarding SET stage='ingesting', ingest_progress_done=0 WHERE customer_key = $1;`
3. **IMAP Get Many** — credential `Gmail IMAP`, mailbox `[Gmail]/Sent Mail`, filter `since: {{ $today.minus({months:6}).toFormat('dd-LLL-yyyy') }}`, limit `2000`. Emits one item per sent email.
4. **Postgres: Set ingest_progress_total** — once from the item count.
5. **Loop Over Items** — iterate each sent email:
   a. **Function: Extract Fields** — pull `from`, `to`, `subject`, `text`, `date`.
   b. **HTTP Request: Embed** — POST to `http://ollama:11434/api/embeddings` with body `{"model":"nomic-embed-text:v1.5","prompt":"<subject>\n<body>"}`. Extract `embedding` (768-dim array).
   c. **HTTP Request: Upsert Qdrant** — PUT to `http://qdrant:6333/collections/mailbox_rag/points` with payload:
      ```json
      {
        "points": [{
          "id": "{{ 'sent:' + $json.messageId }}",
          "vector": "={{ $('HTTP Request: Embed').item.json.embedding }}",
          "payload": {
            "source": "sent_email",
            "source_id": "={{ 'sent:' + $json.messageId }}",
            "text": "={{ ($json.subject || '') + '\\n' + ($json.text || '') }}",
            "meta": { "from": "={{ $json.from }}", "to": "={{ $json.to }}", "date": "={{ $json.date }}" }
          }
        }]
      }
      ```
   d. **Postgres: Increment progress** — `UPDATE mailbox.onboarding SET ingest_progress_done = ingest_progress_done + 1 WHERE customer_key = $1;`
   e. **(side effect)** Also insert the sent email as an entry in `mailbox.sent_history` with `draft_source='local_qwen3'` default (historical marker, `draft_sent` = body). Plan 02-08 uses this as the source for persona curation.
6. **Postgres: Set onboarding stage** — `UPDATE mailbox.onboarding SET stage='pending_tuning' WHERE customer_key = $1;` (gates the onboarding wizard, Plan 02-08 observes it).

Workflow shape:
```json
{
  "name": "06-rag-ingest-sent-history",
  "active": false,
  "nodes": [ ... ],
  "connections": { ... },
  "settings": { "executionOrder": "v1", "saveExecutionProgress": true, "executionTimeout": 3600 },
  "tags": [{"name":"phase-2"}, {"name":"onboarding"}, {"name":"rag"}]
}
```
(`active: false` is intentional — this is a sub-workflow invoked by the onboarding flow, not a standalone trigger.)
</action>
<read_first>
  - dashboard/backend/src/rag/client.ts  (Qdrant collection contract)
  - .planning/phases/02-email-pipeline-core/02-CONTEXT.md  (D-08 6-month corpus, D-12 staged async, D-16 state machine)
  - .planning/REQUIREMENTS.md  (RAG-01 6mo sent history)
  - dashboard/backend/src/db/schema.ts  (onboarding, sent_history shapes)
</read_first>
<acceptance_criteria>
- `n8n/workflows/06-rag-ingest-sent-history.json` exists and is valid JSON
- `jq -r '.name' n8n/workflows/06-rag-ingest-sent-history.json` returns `06-rag-ingest-sent-history`
- `grep -c 'nomic-embed-text:v1.5' n8n/workflows/06-rag-ingest-sent-history.json` returns at least `1`
- `grep -c 'mailbox_rag' n8n/workflows/06-rag-ingest-sent-history.json` returns at least `1`
- `grep -c 'ingest_progress_done' n8n/workflows/06-rag-ingest-sent-history.json` returns at least `1`
- `grep -c "'ingesting'\\|\"ingesting\"" n8n/workflows/06-rag-ingest-sent-history.json` returns at least `1`
- `grep -c "'pending_tuning'\\|\"pending_tuning\"" n8n/workflows/06-rag-ingest-sent-history.json` returns at least `1`
</acceptance_criteria>
</task>

<task id="6">
<action>
Create `n8n/workflows/07-rag-index-new-message.json` — incremental indexer invoked by `01-email-pipeline-main` AFTER the draft_queue insert (add an Execute Workflow edge in plan 02-04's main workflow — or directly in this plan by editing 01-email-pipeline-main.json to add the hand-off). Node graph:

1. **Execute Workflow Trigger** — accepts `{ email_raw_id }`.
2. **Postgres: Fetch email_raw** — `SELECT id, subject, body_text, message_id, from_addr, to_addr, received_at FROM mailbox.email_raw WHERE id = $1;`
3. **HTTP Request: Embed** — same as 06 but for inbound: `{model: 'nomic-embed-text:v1.5', prompt: subject + '\n' + body_text}`.
4. **HTTP Request: Upsert Qdrant** — same shape with `source='inbound_email'`, `source_id='inbound:' + messageId`, `meta: { from, to, received_at }`.

This workflow fires on every new inbound email after onboarding goes live (RAG-03). Execute from `01-email-pipeline-main` with a fire-and-forget branch after `draft_queue` insert so drafting is not blocked by embed latency.
</action>
<read_first>
  - n8n/workflows/03-classify-email-sub.json
  - dashboard/backend/src/rag/client.ts
</read_first>
<acceptance_criteria>
- `n8n/workflows/07-rag-index-new-message.json` exists and is valid JSON
- `jq -r '.name' n8n/workflows/07-rag-index-new-message.json` returns `07-rag-index-new-message`
- `grep 'inbound_email' n8n/workflows/07-rag-index-new-message.json` matches
- `grep 'nomic-embed-text:v1.5' n8n/workflows/07-rag-index-new-message.json` matches
- `grep 'mailbox_rag' n8n/workflows/07-rag-index-new-message.json` matches
</acceptance_criteria>
</task>

<task id="7">
<action>
Build, deploy, and smoke-test the RAG stack end-to-end:

```bash
# 1. Pre-pull the embedding model
docker compose exec -T ollama ollama pull nomic-embed-text:v1.5

# 2. Rebuild dashboard with new RAG routes
docker compose build dashboard
docker compose up -d dashboard

# 3. Wait for /api/kb to accept requests (ensureCollection runs at startup)
for i in $(seq 1 10); do
  if curl -fsS http://localhost:3000/api/health >/dev/null; then break; fi
  sleep 3
done

# 4. Verify collection exists in Qdrant
curl -fsS http://localhost:6333/collections/mailbox_rag | jq .result.config.params.vectors

# 5. Upload a small PDF and confirm chunks are indexed
printf '%s\n' "Sample knowledge base document for the MailBox One smoke test. This is paragraph one." "" "This is paragraph two. It contains product pricing information." > /tmp/kb-sample.txt
curl -fsS -X POST http://localhost:3000/api/kb/documents -F "file=@/tmp/kb-sample.txt"

# 6. List documents
curl -fsS http://localhost:3000/api/kb/documents | jq .

# 7. Search (direct qdrant call with a manually embedded query)
QUERY_VEC=$(curl -fsS -X POST http://localhost:11434/api/embeddings -H 'content-type: application/json' -d '{"model":"nomic-embed-text:v1.5","prompt":"product pricing"}' | jq -c .embedding)
curl -fsS -X POST http://localhost:6333/collections/mailbox_rag/points/search -H 'content-type: application/json' -d "{\"vector\": $QUERY_VEC, \"limit\": 3, \"with_payload\": true, \"score_threshold\": 0.4}" | jq .

# 8. Import the two new sub-workflows
./scripts/n8n-import-workflows.sh
```
</action>
<read_first>
  - dashboard/backend/src/rag/client.ts
  - dashboard/backend/src/routes/kb.ts
  - n8n/workflows/06-rag-ingest-sent-history.json
  - n8n/workflows/07-rag-index-new-message.json
</read_first>
<acceptance_criteria>
- `curl -fsS http://localhost:6333/collections/mailbox_rag | jq -r '.result.status'` returns `green` or `ok`
- `curl -fsS http://localhost:6333/collections/mailbox_rag | jq -r '.result.config.params.vectors.size'` returns `768`
- `curl -fsS http://localhost:6333/collections/mailbox_rag | jq -r '.result.config.params.vectors.distance'` returns `Cosine`
- `curl -fsS -X POST http://localhost:3000/api/kb/documents -F "file=@/tmp/kb-sample.txt" | jq -r '.chunks'` returns a positive integer
- `curl -fsS http://localhost:3000/api/kb/documents | jq '.documents | length'` returns at least `1`
- `docker compose exec -T n8n n8n list:workflow | grep -q '06-rag-ingest-sent-history'`
- `docker compose exec -T n8n n8n list:workflow | grep -q '07-rag-index-new-message'`
</acceptance_criteria>
</task>

</tasks>

<verification>
```bash
# 1. Collection exists with correct shape
curl -fsS http://localhost:6333/collections/mailbox_rag | jq -e '.result.config.params.vectors.size == 768 and .result.config.params.vectors.distance == "Cosine"' > /dev/null

# 2. Document upload + list + delete round-trip
SID=$(curl -fsS -X POST http://localhost:3000/api/kb/documents -F "file=@/tmp/kb-sample.txt" | jq -r .source_id)
curl -fsS http://localhost:3000/api/kb/documents | jq -e --arg sid "$SID" '.documents[] | select(.source_id == $sid)' > /dev/null
curl -fsS -X DELETE "http://localhost:3000/api/kb/documents/$SID" -o /dev/null -w '%{http_code}' | grep -q 204

# 3. Similarity threshold enforced in code
grep -q '0.72' dashboard/backend/src/rag/client.ts

# 4. Both RAG workflows imported
docker compose exec -T n8n n8n list:workflow | grep -q '06-rag-ingest-sent-history'
docker compose exec -T n8n n8n list:workflow | grep -q '07-rag-index-new-message'

# 5. Embed dim guard present
grep -q '768' dashboard/backend/src/rag/embed.ts
```
</verification>
