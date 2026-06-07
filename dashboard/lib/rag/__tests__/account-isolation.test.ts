// dashboard/lib/rag/__tests__/account-isolation.test.ts
//
// MBOX-352 (MBOX-162 V2) — per-account RAG isolation. Asserts:
//   1. pointIdFromAccountMessage is a deterministic, valid UUID, distinct from
//      the legacy message_id-only key and distinct across accounts.
//   2. retrieveForDraft with account_id set sends an account_id hard-filter to
//      Qdrant AND excludes BOTH the legacy and account-scoped self point ids
//      (the dual-key window).
//   3. retrieveForDraft without account_id is byte-identical to pre-V2 (no
//      account filter; only the legacy self id excluded).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { pointIdFromAccountMessage, pointIdFromMessageId } from '../qdrant';
import { retrieveForDraft } from '../retrieve';

const MESSAGE_ID = '19c813bde357dc32';
const ACCOUNT_ID = 7;
const LEGACY_ID = pointIdFromMessageId(MESSAGE_ID);
const ACCT_ID = pointIdFromAccountMessage(ACCOUNT_ID, MESSAGE_ID);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

const baseInput = {
  from_addr: 'cust@example.com',
  subject: 'Re: order',
  body_text: 'Confirming the order details for the Q3 shipment we discussed.',
  persona_key: 'default',
  message_id: MESSAGE_ID,
};

function mockEmbedAndSearch(captured: { value: unknown }) {
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.includes('/api/embeddings')) {
      return new Response(JSON.stringify({ embedding: new Array(768).fill(0.01) }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    if (url.includes('/collections/email_messages/points/search')) {
      captured.value = init?.body ? JSON.parse(String(init.body)) : null;
      return new Response(JSON.stringify({ result: [] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    if (url.includes('/collections/kb_documents/points/search')) {
      return new Response(JSON.stringify({ result: [] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    return new Response('not found', { status: 404 });
  }) as unknown as typeof fetch;
}

describe('pointIdFromAccountMessage — MBOX-352', () => {
  it('is a syntactically valid UUID v4', () => {
    expect(ACCT_ID).toMatch(UUID_RE);
  });

  it('is deterministic for the same (account, message)', () => {
    expect(pointIdFromAccountMessage(ACCOUNT_ID, MESSAGE_ID)).toBe(ACCT_ID);
  });

  it('differs from the legacy message_id-only key', () => {
    expect(ACCT_ID).not.toBe(LEGACY_ID);
  });

  it('differs across accounts for the same message (no cross-account collision)', () => {
    expect(pointIdFromAccountMessage(ACCOUNT_ID, MESSAGE_ID)).not.toBe(
      pointIdFromAccountMessage(ACCOUNT_ID + 1, MESSAGE_ID),
    );
  });
});

describe('retrieveForDraft account isolation — MBOX-352', () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    process.env.OLLAMA_BASE_URL = 'http://test-ollama:11434';
    process.env.QDRANT_URL = 'http://test-qdrant:6333';
    delete process.env.RAG_DISABLED;
    delete process.env.RAG_CLOUD_ROUTE_ENABLED;
    delete process.env.MAILBOX_OPERATOR_EMAIL; // inbound-only search (single call)
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('sends an account_id hard-filter + excludes both self ids when account_id is set', async () => {
    const captured: { value: unknown } = { value: null };
    mockEmbedAndSearch(captured);

    await retrieveForDraft({ ...baseInput, draft_source: 'local', account_id: ACCOUNT_ID });

    const body = captured.value as {
      filter?: {
        must?: Array<{ key?: string; match?: { value?: unknown } }>;
        must_not?: Array<{ has_id?: string[] }>;
      };
    };
    const accountClause = body.filter?.must?.find((c) => c.key === 'account_id');
    expect(accountClause?.match?.value).toBe(ACCOUNT_ID);

    const excluded = new Set(body.filter?.must_not?.flatMap((c) => c.has_id ?? []) ?? []);
    expect(excluded.has(LEGACY_ID)).toBe(true);
    expect(excluded.has(ACCT_ID)).toBe(true);
  });

  it('omits the account filter and the account-scoped self id when account_id is unset (pre-V2 parity)', async () => {
    const captured: { value: unknown } = { value: null };
    mockEmbedAndSearch(captured);

    await retrieveForDraft({ ...baseInput, draft_source: 'local' });

    const body = captured.value as {
      filter?: {
        must?: Array<{ key?: string }>;
        must_not?: Array<{ has_id?: string[] }>;
      };
    };
    expect(body.filter?.must?.some((c) => c.key === 'account_id')).toBeFalsy();
    const excluded = new Set(body.filter?.must_not?.flatMap((c) => c.has_id ?? []) ?? []);
    expect(excluded.has(LEGACY_ID)).toBe(true);
    expect(excluded.has(ACCT_ID)).toBe(false);
  });
});
