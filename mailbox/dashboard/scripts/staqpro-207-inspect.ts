// dashboard/scripts/staqpro-207-inspect.ts
//
// STAQPRO-207 Phase B — outlier inspection harness.
//
// For each of 10 first-run outlier message_ids, run the live drafter twice
// (with RAG, then with RAG_DISABLED=1) using the SAME primitives as the
// eval harness — assemblePrompt + retrieveForDraft + pickEndpoint +
// getPersonaContext. Capture full inbound body, retrieved refs (with
// excerpt + source + sent_at), both drafts, the actual operator reply,
// and per-pass cosine similarity.
//
// Output: dashboard/eval-results/staqpro-207-inspection-<ISO>.json
//
// Run via the same mailbox-migrate one-shot pattern as the eval harness:
//   docker compose --profile migrate run --rm \
//     -e OLLAMA_BASE_URL=http://ollama:11434 \
//     -e QDRANT_URL=http://qdrant:6333 \
//     mailbox-migrate sh -c "npm install --no-audit --no-fund --silent && \
//       npx tsx scripts/staqpro-207-inspect.ts"

import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { Pool } from 'pg';
import type { Category } from '../lib/classification/prompt';
import { getPersonaContext } from '../lib/drafting/persona';
import { assemblePrompt } from '../lib/drafting/prompt';
import { pickEndpoint } from '../lib/drafting/router';
import { embedText } from '../lib/rag/embed';
import { type RetrievalResult, retrieveForDraft } from '../lib/rag/retrieve';

const OUTLIERS: ReadonlyArray<{ message_id: string; bucket: 'win' | 'loss' }> = [
  { message_id: '19bb7fe899f609ca', bucket: 'loss' },
  { message_id: '19ba502acb1edbf5', bucket: 'loss' },
  { message_id: '19be6b587e3b7d53', bucket: 'loss' },
  { message_id: '19bfc435639d8fc9', bucket: 'loss' },
  { message_id: '19b0ed17519285b1', bucket: 'loss' },
  { message_id: '19b853053d10bd18', bucket: 'win' },
  { message_id: '19c813bde357dc32', bucket: 'win' },
  { message_id: '19c95e5a040c7aaf', bucket: 'win' },
  { message_id: '19a5d5512b6feb1e', bucket: 'win' },
  { message_id: '19be35efc56bd858', bucket: 'win' },
];

const DEFAULT_PERSONA_KEY = 'default';

interface PairRow {
  message_id: string;
  bucket: 'win' | 'loss';
  inbox_id: number;
  thread_id: string | null;
  inbound_from: string | null;
  inbound_to: string | null;
  inbound_subject: string | null;
  inbound_body: string;
  inbound_received_at: string;
  inbound_classification: string | null;
  inbound_confidence: number | null;
  sent_history_id: number | null;
  actual_reply: string | null;
  actual_sent_at: string | null;
  classification_category: string | null;
  classification_confidence: number | null;
}

function cosineSimilarity(a: readonly number[], b: readonly number[]): number {
  if (a.length === 0 || a.length !== b.length) return 0;
  let dot = 0;
  let magA = 0;
  let magB = 0;
  for (let i = 0; i < a.length; i++) {
    const ai = a[i];
    const bi = b[i];
    dot += ai * bi;
    magA += ai * ai;
    magB += bi * bi;
  }
  const denom = Math.sqrt(magA) * Math.sqrt(magB);
  if (denom === 0) return 0;
  return dot / denom;
}

async function loadPairs(pool: Pool): Promise<PairRow[]> {
  const ids = OUTLIERS.map((o) => o.message_id);
  const sql = `
    SELECT
      im.message_id,
      im.id AS inbox_id,
      im.thread_id,
      im.from_addr AS inbound_from,
      im.to_addr AS inbound_to,
      im.subject AS inbound_subject,
      im.body AS inbound_body,
      im.received_at AS inbound_received_at,
      im.classification AS inbound_classification,
      im.confidence AS inbound_confidence,
      sh.id AS sent_history_id,
      sh.draft_sent AS actual_reply,
      sh.sent_at AS actual_sent_at,
      sh.classification_category,
      sh.classification_confidence
    FROM mailbox.inbox_messages im
    LEFT JOIN LATERAL (
      SELECT *
      FROM mailbox.sent_history sh
      WHERE sh.inbox_message_id = im.id
        AND sh.source = 'backfill'
      ORDER BY sh.sent_at DESC
      LIMIT 1
    ) sh ON true
    WHERE im.message_id = ANY($1)
  `;
  const res = await pool.query<PairRow>(sql, [ids]);
  const byId = new Map(res.rows.map((r) => [r.message_id, r]));
  return OUTLIERS.map((o) => {
    const row = byId.get(o.message_id);
    if (!row) return null;
    return { ...row, bucket: o.bucket };
  }).filter((r): r is PairRow => r !== null);
}

interface DraftPass {
  mode: 'with-rag' | 'no-rag';
  prompt_messages: unknown;
  draft_body: string;
  draft_chars: number;
  rag_refs: Array<{
    point_id: string;
    source: string;
    excerpt: string;
    score: number;
    direction: 'inbound' | 'outbound';
    sent_at: string;
  }>;
  rag_reason: RetrievalResult['reason'];
  cosine_vs_actual: number | null;
  endpoint_model: string;
  endpoint_source: 'local' | 'cloud';
  status: 'ok' | 'draft_failed' | 'embed_failed';
  error?: string;
}

async function runDraftPass(pair: PairRow, mode: 'with-rag' | 'no-rag'): Promise<DraftPass> {
  if (mode === 'no-rag') {
    process.env.RAG_DISABLED = '1';
  } else {
    delete process.env.RAG_DISABLED;
  }

  const category: Category = (pair.inbound_classification as Category | null) ?? 'inquiry';
  const confidence = pair.inbound_confidence ?? 1.0;
  // MBOX-352 — getPersonaContext is now account-scoped (numeric account_id);
  // the eval inspector runs against the default account, so pass nothing.
  const persona = await getPersonaContext();
  const endpoint = pickEndpoint(category, confidence);

  const retrieval = await retrieveForDraft({
    from_addr: pair.inbound_from ?? '',
    subject: pair.inbound_subject ?? null,
    body_text: pair.inbound_body ?? null,
    draft_source: endpoint.source,
    persona_key: DEFAULT_PERSONA_KEY,
    // STAQPRO-219 — drop self-match from retrieval (inspect harness mirrors
    // live drafter behavior).
    message_id: pair.message_id,
    // STAQPRO-222 (H3) — same-thread suppression, gated inside
    // retrieveForDraft by RAG_RETRIEVE_EXCLUDE_SAME_THREAD.
    thread_id: pair.thread_id,
  });

  const assembled = assemblePrompt({
    from_addr: pair.inbound_from ?? '',
    to_addr: pair.inbound_to ?? '',
    subject: pair.inbound_subject ?? '',
    body_text: pair.inbound_body ?? '',
    category,
    confidence,
    persona,
    rag_refs: retrieval.refs,
  });

  const url = `${endpoint.baseUrl}/api/chat`;
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (endpoint.apiKey) headers.authorization = `Bearer ${endpoint.apiKey}`;

  let draftBody = '';
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: endpoint.model,
        messages: assembled.messages,
        stream: false,
        options: {
          temperature: assembled.temperature,
          num_predict: assembled.max_tokens,
        },
      }),
    });
    if (!res.ok) {
      throw new Error(`ollama /api/chat returned ${res.status}: ${await res.text()}`);
    }
    const data = (await res.json()) as { message?: { content?: string } };
    draftBody = data.message?.content ?? '';
  } catch (err) {
    return {
      mode,
      prompt_messages: assembled.messages,
      draft_body: '',
      draft_chars: 0,
      rag_refs: retrieval.refs.map((r) => ({
        point_id: r.point_id,
        source: r.source,
        excerpt: r.excerpt,
        score: r.score,
        direction: r.direction,
        sent_at: r.sent_at,
      })),
      rag_reason: retrieval.reason,
      cosine_vs_actual: null,
      endpoint_model: endpoint.model,
      endpoint_source: endpoint.source,
      status: 'draft_failed',
      error: err instanceof Error ? err.message : String(err),
    };
  }

  let cosine: number | null = null;
  let status: 'ok' | 'embed_failed' = 'ok';
  let embedError: string | undefined;
  if (draftBody.trim() && pair.actual_reply?.trim()) {
    try {
      const [draftVec, actualVec] = await Promise.all([
        embedText(draftBody),
        embedText(pair.actual_reply),
      ]);
      if (draftVec && actualVec) {
        cosine = cosineSimilarity(draftVec, actualVec);
      } else {
        status = 'embed_failed';
        embedError = 'embed returned null';
      }
    } catch (err) {
      status = 'embed_failed';
      embedError = err instanceof Error ? err.message : String(err);
    }
  } else {
    status = 'embed_failed';
    embedError = 'empty draft or actual reply';
  }

  return {
    mode,
    prompt_messages: assembled.messages,
    draft_body: draftBody,
    draft_chars: draftBody.length,
    rag_refs: retrieval.refs.map((r) => ({
      point_id: r.point_id,
      source: r.source,
      excerpt: r.excerpt,
      score: r.score,
      direction: r.direction,
      sent_at: r.sent_at,
    })),
    rag_reason: retrieval.reason,
    cosine_vs_actual: cosine,
    endpoint_model: endpoint.model,
    endpoint_source: endpoint.source,
    status,
    error: embedError,
  };
}

async function main(): Promise<void> {
  const pgUrl = process.env.POSTGRES_URL;
  if (!pgUrl) throw new Error('POSTGRES_URL not set');
  const pool = new Pool({ connectionString: pgUrl });
  try {
    const pairs = await loadPairs(pool);
    if (pairs.length !== OUTLIERS.length) {
      console.warn(`[inspect] expected ${OUTLIERS.length} pairs, got ${pairs.length}`);
    }
    const packets = [];
    for (const pair of pairs) {
      console.log(`[inspect] ${pair.bucket} ${pair.message_id} (${pair.inbound_from})`);
      const withRag = await runDraftPass(pair, 'with-rag');
      console.log(
        `  with-rag: refs=${withRag.rag_refs.length} reason=${withRag.rag_reason} cos=${withRag.cosine_vs_actual?.toFixed(4)} status=${withRag.status}`,
      );
      const noRag = await runDraftPass(pair, 'no-rag');
      console.log(
        `  no-rag:   refs=${noRag.rag_refs.length} reason=${noRag.rag_reason} cos=${noRag.cosine_vs_actual?.toFixed(4)} status=${noRag.status}`,
      );
      packets.push({
        bucket: pair.bucket,
        message_id: pair.message_id,
        thread_id: pair.thread_id,
        inbound_from: pair.inbound_from,
        inbound_to: pair.inbound_to,
        inbound_subject: pair.inbound_subject,
        inbound_body: pair.inbound_body,
        inbound_body_chars: pair.inbound_body?.length ?? 0,
        inbound_received_at: pair.inbound_received_at,
        actual_reply: pair.actual_reply,
        actual_reply_chars: pair.actual_reply?.length ?? 0,
        actual_sent_at: pair.actual_sent_at,
        classification_category: pair.classification_category,
        classification_confidence: pair.classification_confidence,
        with_rag: withRag,
        no_rag: noRag,
        delta_cosine:
          withRag.cosine_vs_actual !== null && noRag.cosine_vs_actual !== null
            ? withRag.cosine_vs_actual - noRag.cosine_vs_actual
            : null,
      });
    }
    const outDir = path.resolve('eval-results');
    await mkdir(outDir, { recursive: true });
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const outPath = path.join(outDir, `staqpro-207-inspection-${ts}.json`);
    await writeFile(
      outPath,
      JSON.stringify(
        {
          generated_at: new Date().toISOString(),
          outliers_inspected: packets.length,
          packets,
        },
        null,
        2,
      ),
      'utf-8',
    );
    console.log(`\n[inspect] wrote ${outPath}`);
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error('[inspect] fatal:', err);
  process.exit(1);
});
