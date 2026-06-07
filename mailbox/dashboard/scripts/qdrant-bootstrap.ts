// dashboard/scripts/qdrant-bootstrap.ts
//
// STAQPRO-188 — idempotent Qdrant bootstrap. Two collections as of STAQPRO-148:
//   - `email_messages` (STAQPRO-188): inbound + outbound email message embeddings
//   - `kb_documents`   (STAQPRO-148): operator-uploaded SOP / price-sheet / policy chunks
//
// Why a script instead of extending mailbox-migrate: the migrate profile is the
// Postgres schema-versioning surface (mailbox.migrations table, .sql files).
// Qdrant collection state lives entirely server-side in Qdrant — no migration
// log, no SQL — so coupling it to the Postgres runner blurs the boundary.
// Instead, this is its own one-shot compose step (`mailbox-qdrant-bootstrap`
// profile) that runs to completion and exits.
//
// Idempotency: PUT /collections/{name} returns 200 OK and is a no-op if the
// collection already exists with matching config. Payload index creates use
// PUT and Qdrant treats them as upserts (no error if the index already
// exists). Re-running this script on every appliance boot is safe.
//
// Vector config: 768 dims / Cosine distance for both collections — matches
// nomic-embed-text:v1.5 which is trained for cosine similarity. Vector size
// is the model's embedding dimension; do not change without re-embedding.

import process from 'node:process';

const QDRANT_URL = process.env.QDRANT_URL ?? 'http://qdrant:6333';
const VECTOR_SIZE = 768; // nomic-embed-text:v1.5
const DISTANCE = 'Cosine';

interface PayloadIndex {
  field: string;
  schema: 'keyword' | 'datetime' | 'integer';
}

interface CollectionSpec {
  name: string;
  payloadIndexes: PayloadIndex[];
}

// Indexed payload fields per collection. Keep narrow and intentional —
// each indexed field costs Qdrant memory; only index what we filter or
// sort by.
const COLLECTIONS: CollectionSpec[] = [
  {
    name: 'email_messages',
    payloadIndexes: [
      // STAQPRO-188 / STAQPRO-191
      { field: 'message_id', schema: 'keyword' },
      { field: 'thread_id', schema: 'keyword' },
      { field: 'sender', schema: 'keyword' },
      { field: 'direction', schema: 'keyword' },
      { field: 'sent_at', schema: 'datetime' },
      { field: 'classification_category', schema: 'keyword' },
      { field: 'persona_key', schema: 'keyword' },
    ],
  },
  {
    name: 'kb_documents',
    payloadIndexes: [
      // STAQPRO-148
      // - doc_id:      cascade-delete filter target (DELETE /api/kb-documents/[id])
      // - chunk_index: ordered preview / debugging
      // - mime_type:   future filter for biasing toward policy vs price-sheet
      { field: 'doc_id', schema: 'integer' },
      { field: 'chunk_index', schema: 'integer' },
      { field: 'mime_type', schema: 'keyword' },
    ],
  },
];

interface QdrantErrorBody {
  status?: { error?: string };
}

async function qdrantRequest(
  method: 'GET' | 'PUT',
  path: string,
  body?: unknown,
): Promise<{ status: number; json: unknown }> {
  const res = await fetch(`${QDRANT_URL}${path}`, {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json: unknown;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = text;
  }
  return { status: res.status, json };
}

async function ensureCollection(name: string): Promise<void> {
  const probe = await qdrantRequest('GET', `/collections/${name}`);
  if (probe.status === 200) {
    console.log(`[qdrant-bootstrap] collection '${name}' already exists — skip create`);
    return;
  }
  if (probe.status !== 404) {
    throw new Error(
      `[qdrant-bootstrap] unexpected status ${probe.status} probing collection '${name}': ${JSON.stringify(probe.json)}`,
    );
  }

  const create = await qdrantRequest('PUT', `/collections/${name}`, {
    vectors: { size: VECTOR_SIZE, distance: DISTANCE },
  });
  if (create.status !== 200) {
    const err =
      (create.json as QdrantErrorBody | null)?.status?.error ?? JSON.stringify(create.json);
    throw new Error(
      `[qdrant-bootstrap] create collection '${name}' failed (${create.status}): ${err}`,
    );
  }
  console.log(`[qdrant-bootstrap] created collection '${name}' (${VECTOR_SIZE}d ${DISTANCE})`);
}

async function ensurePayloadIndexes(name: string, indexes: PayloadIndex[]): Promise<void> {
  for (const idx of indexes) {
    const res = await qdrantRequest('PUT', `/collections/${name}/index`, {
      field_name: idx.field,
      field_schema: idx.schema,
    });
    if (res.status !== 200) {
      const err = (res.json as QdrantErrorBody | null)?.status?.error ?? JSON.stringify(res.json);
      throw new Error(
        `[qdrant-bootstrap] payload index ${name}/${idx.field} (${idx.schema}) failed (${res.status}): ${err}`,
      );
    }
    console.log(
      `[qdrant-bootstrap] '${name}' payload index '${idx.field}' (${idx.schema}) ensured`,
    );
  }
}

async function main(): Promise<void> {
  console.log(`[qdrant-bootstrap] target=${QDRANT_URL}`);
  for (const spec of COLLECTIONS) {
    console.log(`[qdrant-bootstrap] === ${spec.name} ===`);
    await ensureCollection(spec.name);
    await ensurePayloadIndexes(spec.name, spec.payloadIndexes);
  }
  console.log('[qdrant-bootstrap] complete');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
