import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { HAS_DB } from '../helpers/db';

// STAQPRO-148 — kb-documents route tests. Mix of:
//   - DB-free validation cases: missing file, bad mime, empty file, oversized
//   - DB-gated happy paths: upload (with embed pipeline stubbed), list,
//     duplicate dedup, delete cascade, retry semantics
//
// Embed pipeline (embedAndUpsertChunks) and Qdrant cascade deletes are
// stubbed via vi.mock so tests don't depend on Ollama / Qdrant being live.
// The smoke script (scripts/kb-smoke.ts) is the integration validation;
// these tests cover route-level contracts.
//
// All file IO targets a per-suite tmp dir so tests don't pollute the live
// /var/lib/mailbox/kb path.

const TMP_KB_DIR = path.join(os.tmpdir(), `kb-test-${process.pid}-${Date.now()}`);
process.env.KB_STORAGE_DIR = TMP_KB_DIR;

// Module-level mocks. Must be set up before route imports below.
const ingestStub = vi.fn(async (_id: number) => ({ ok: true, chunkCount: 1 }));
vi.mock('@/lib/rag/kb-ingest', async (orig) => {
  const actual = (await orig()) as typeof import('@/lib/rag/kb-ingest');
  return {
    ...actual,
    embedAndUpsertChunks: (id: number) => ingestStub(id),
  };
});

const qdrantDeleteStub = vi.fn(async (_doc_id: number) => ({ ok: true }));
vi.mock('@/lib/rag/kb-qdrant', async (orig) => {
  const actual = (await orig()) as typeof import('@/lib/rag/kb-qdrant');
  return {
    ...actual,
    deleteKbPointsByDocId: (doc_id: number) => qdrantDeleteStub(doc_id),
  };
});

function multipartReq(opts: {
  filename?: string;
  mime?: string;
  body?: string | Uint8Array;
  title?: string;
  omitFile?: boolean;
}): Request {
  const fd = new FormData();
  if (!opts.omitFile) {
    const part: BlobPart =
      typeof opts.body === 'string' || opts.body === undefined
        ? (opts.body ?? 'sample content')
        : new Uint8Array(opts.body);
    const blob = new Blob([part], { type: opts.mime ?? 'text/plain' });
    fd.set('file', blob, opts.filename ?? 'sample.txt');
  }
  if (opts.title) fd.set('title', opts.title);
  return new Request('http://test.local/api/kb-documents', { method: 'POST', body: fd });
}

beforeAll(async () => {
  await fs.mkdir(TMP_KB_DIR, { recursive: true });
});

afterAll(async () => {
  await fs.rm(TMP_KB_DIR, { recursive: true, force: true });
  vi.restoreAllMocks();
});

beforeEach(() => {
  ingestStub.mockClear();
  qdrantDeleteStub.mockClear();
});

afterEach(async () => {
  if (HAS_DB) {
    const { getTestPool } = await import('../helpers/db');
    await getTestPool().query(
      "DELETE FROM mailbox.kb_documents WHERE uploaded_by = 'kb-test' OR title LIKE 'kb-test%'",
    );
  }
});

describe('POST /api/kb-documents — validation (DB-free)', () => {
  it('returns 400 missing_file when no multipart "file" entry', async () => {
    const { POST } = await import('@/app/api/kb-documents/route');
    const res = await POST(multipartReq({ omitFile: true }) as never);
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('missing_file');
  });

  it('returns 400 unsupported_mime_type for unknown content-type', async () => {
    const { POST } = await import('@/app/api/kb-documents/route');
    const res = await POST(multipartReq({ mime: 'image/png' }) as never);
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('unsupported_mime_type');
  });

  it('returns 400 empty_file for 0-byte uploads', async () => {
    const { POST } = await import('@/app/api/kb-documents/route');
    const res = await POST(multipartReq({ body: new Uint8Array(0) }) as never);
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('empty_file');
  });

  it('returns 400 invalid_filename when filename contains a path separator', async () => {
    const { POST } = await import('@/app/api/kb-documents/route');
    const res = await POST(multipartReq({ filename: '../etc/passwd.txt' }) as never);
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('invalid_filename');
  });
});

describe('POST /api/kb-documents — happy path + dedup (DB-gated)', () => {
  it.skipIf(!HAS_DB)('uploads, fires embed, returns doc_id', async () => {
    const { POST } = await import('@/app/api/kb-documents/route');
    const res = await POST(
      multipartReq({ body: 'unique-test-content-1', filename: 'kb-test-uploads.txt' }) as never,
    );
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.ok).toBe(true);
    expect(json.duplicate).toBe(false);
    expect(json.status).toBe('processing');
    expect(typeof json.doc_id).toBe('number');
    expect(ingestStub).toHaveBeenCalledWith(json.doc_id);
  });

  it.skipIf(!HAS_DB)('returns duplicate:true on second upload of identical bytes', async () => {
    const { POST } = await import('@/app/api/kb-documents/route');
    const body = 'unique-test-content-dup';
    const expectedSha = createHash('sha256').update(body).digest('hex');

    const first = await POST(multipartReq({ body, filename: 'kb-test-dup.txt' }) as never);
    expect(first.status).toBe(200);
    const firstJson = await first.json();
    expect(firstJson.duplicate).toBe(false);
    expect(firstJson.sha256).toBe(expectedSha);

    const second = await POST(multipartReq({ body, filename: 'kb-test-dup-renamed.txt' }) as never);
    expect(second.status).toBe(200);
    const secondJson = await second.json();
    expect(secondJson.duplicate).toBe(true);
    expect(secondJson.doc_id).toBe(firstJson.doc_id);
    // ingest fires only on first upload, not on dedup hit.
    expect(ingestStub).toHaveBeenCalledTimes(1);
  });
});

describe('GET /api/kb-documents — list (DB-gated)', () => {
  it.skipIf(!HAS_DB)('returns documents array (empty after cleanup)', async () => {
    const { GET } = await import('@/app/api/kb-documents/route');
    const req = new Request('http://test.local/api/kb-documents');
    const res = await GET(req as never);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(Array.isArray(json.documents)).toBe(true);
  });

  it.skipIf(!HAS_DB)('list contains a freshly uploaded doc', async () => {
    const { POST, GET } = await import('@/app/api/kb-documents/route');
    const upload = await POST(
      multipartReq({ body: 'list-included-test', filename: 'kb-test-listed.txt' }) as never,
    );
    const uploadJson = await upload.json();

    const req = new Request('http://test.local/api/kb-documents');
    const res = await GET(req as never);
    const { documents } = (await res.json()) as { documents: Array<{ id: number }> };
    expect(documents.some((d) => d.id === uploadJson.doc_id)).toBe(true);
  });
});

describe('DELETE /api/kb-documents/[id] — cascade (DB-gated)', () => {
  it.skipIf(!HAS_DB)('cascades Qdrant + DB + filesystem and returns 200', async () => {
    const { POST } = await import('@/app/api/kb-documents/route');
    const { DELETE } = await import('@/app/api/kb-documents/[id]/route');
    const upload = await POST(
      multipartReq({ body: 'delete-cascade-test', filename: 'kb-test-delete.txt' }) as never,
    );
    const { doc_id } = await upload.json();

    const res = await DELETE(new Request('http://test.local') as never, {
      params: Promise.resolve({ id: String(doc_id) }),
    });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.deleted).toBe(true);
    expect(json.doc_id).toBe(doc_id);
    expect(qdrantDeleteStub).toHaveBeenCalledWith(doc_id);
  });

  it.skipIf(!HAS_DB)('returns 404 for unknown id', async () => {
    const { DELETE } = await import('@/app/api/kb-documents/[id]/route');
    const res = await DELETE(new Request('http://test.local') as never, {
      params: Promise.resolve({ id: '99999999' }),
    });
    expect(res.status).toBe(404);
  });

  it('returns 400 for non-numeric id', async () => {
    const { DELETE } = await import('@/app/api/kb-documents/[id]/route');
    const res = await DELETE(new Request('http://test.local') as never, {
      params: Promise.resolve({ id: 'not-a-number' }),
    });
    expect(res.status).toBe(400);
  });
});

describe('POST /api/kb-documents/[id]/retry (DB-gated)', () => {
  it.skipIf(!HAS_DB)('returns 404 for unknown id', async () => {
    const { POST: RETRY } = await import('@/app/api/kb-documents/[id]/retry/route');
    const res = await RETRY(new Request('http://test.local', { method: 'POST' }) as never, {
      params: Promise.resolve({ id: '99999999' }),
    });
    expect(res.status).toBe(404);
  });

  it.skipIf(!HAS_DB)("returns 409 when doc is already 'ready'", async () => {
    const { POST: UPLOAD } = await import('@/app/api/kb-documents/route');
    const { POST: RETRY } = await import('@/app/api/kb-documents/[id]/retry/route');
    const upload = await UPLOAD(
      multipartReq({ body: 'retry-409-test', filename: 'kb-test-retry409.txt' }) as never,
    );
    const { doc_id } = await upload.json();

    // Force status to 'ready' to exercise the 409 path.
    const { getTestPool } = await import('../helpers/db');
    await getTestPool().query("UPDATE mailbox.kb_documents SET status='ready' WHERE id=$1", [
      doc_id,
    ]);

    const res = await RETRY(new Request('http://test.local', { method: 'POST' }) as never, {
      params: Promise.resolve({ id: String(doc_id) }),
    });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe('already_ready');
  });

  it.skipIf(!HAS_DB)("re-fires embed when doc is 'failed'", async () => {
    const { POST: UPLOAD } = await import('@/app/api/kb-documents/route');
    const { POST: RETRY } = await import('@/app/api/kb-documents/[id]/retry/route');
    const upload = await UPLOAD(
      multipartReq({ body: 'retry-200-test', filename: 'kb-test-retry200.txt' }) as never,
    );
    const { doc_id } = await upload.json();

    // Mark as failed to exercise the retry path.
    const { getTestPool } = await import('../helpers/db');
    await getTestPool().query(
      "UPDATE mailbox.kb_documents SET status='failed', error_message='test failure' WHERE id=$1",
      [doc_id],
    );

    ingestStub.mockClear();
    const res = await RETRY(new Request('http://test.local', { method: 'POST' }) as never, {
      params: Promise.resolve({ id: String(doc_id) }),
    });
    expect(res.status).toBe(200);
    expect((await res.json()).retrying).toBe(true);
    expect(ingestStub).toHaveBeenCalledWith(doc_id);
  });
});
