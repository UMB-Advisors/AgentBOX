import { describe, expect, it } from 'vitest';
import { pointIdFromMessageId } from '@/lib/rag/qdrant';

// STAQPRO-190 — pointIdFromMessageId is the idempotency key for Qdrant
// upserts. Two assertions matter:
//   1. Determinism: same message_id → same UUID (re-running backfill or
//      replaying an n8n event must overwrite the existing point, not
//      duplicate).
//   2. RFC 4122 v4 shape: Qdrant accepts UUID strings in this exact form;
//      a malformed UUID is rejected at API boundary.

describe('pointIdFromMessageId — STAQPRO-190', () => {
  it('is deterministic for the same message_id', () => {
    const a = pointIdFromMessageId('msg-abc-123');
    const b = pointIdFromMessageId('msg-abc-123');
    expect(a).toBe(b);
  });

  it('is distinct for different message_ids', () => {
    const a = pointIdFromMessageId('msg-abc-123');
    const b = pointIdFromMessageId('msg-abc-124');
    expect(a).not.toBe(b);
  });

  it('emits a syntactically-valid UUID v4 (8-4-4-4-12 with version+variant nibbles set)', () => {
    const u = pointIdFromMessageId('any-message-id');
    expect(u).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it('handles long Gmail-style message ids', () => {
    const id = '<CAA1xY2x_123abc.def456@mail.gmail.com>';
    const u = pointIdFromMessageId(id);
    expect(u).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });
});
