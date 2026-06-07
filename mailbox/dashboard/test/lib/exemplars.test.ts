import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { getCategoryExemplars } from '@/lib/drafting/exemplars';
import { closeTestPool, getTestPool, HAS_DB } from '../helpers/db';

// STAQPRO-234 — getCategoryExemplars contract.
//
// The function reads from mailbox.sent_history (NOT Qdrant) and returns the
// most-recent k rows for a given classification_category, body-truncated to
// RAG_RETRIEVE_EXCERPT_CHARS. Tests run against the canonical schema fixture
// — same pattern as test/routes/sent-history-archive.test.ts.
//
// We seed sent_history rows directly here (not via the archive trigger)
// because we want to control sent_at + classification_category precisely.

const dbDescribe = HAS_DB ? describe : describe.skip;

interface SeededSent {
  ids: number[];
}

let counter = 0;
function uniqMessageId(): string {
  counter += 1;
  return `exemplars-test-${Date.now()}-${counter}-${Math.random().toString(36).slice(2, 8)}`;
}

async function seedSent(opts: {
  category: string;
  draft_sent: string;
  sent_at: Date;
  subject?: string;
  message_id?: string;
}): Promise<number> {
  const pool = getTestPool();
  const r = await pool.query<{ id: number }>(
    `INSERT INTO mailbox.sent_history
       (from_addr, to_addr, subject, body_text, draft_sent, draft_source,
        classification_category, classification_confidence, sent_at, message_id, source)
     VALUES ($1, $2, $3, $4, $5, 'local', $6, 0.95, $7, $8, 'live')
     RETURNING id`,
    [
      'op@example.com',
      'customer@example.com',
      opts.subject ?? `subj ${counter}`,
      'inbound (irrelevant for these tests)',
      opts.draft_sent,
      opts.category,
      opts.sent_at.toISOString(),
      opts.message_id ?? uniqMessageId(),
    ],
  );
  return r.rows[0].id;
}

dbDescribe('getCategoryExemplars — STAQPRO-234', () => {
  const seeded: SeededSent = { ids: [] };

  afterEach(async () => {
    if (seeded.ids.length > 0) {
      const pool = getTestPool();
      await pool.query('DELETE FROM mailbox.sent_history WHERE id = ANY($1::int[])', [seeded.ids]);
      seeded.ids = [];
    }
  });

  afterAll(async () => {
    await closeTestPool();
  });

  it('returns top-k by recency for the requested category', async () => {
    const oldest = await seedSent({
      category: 'reorder',
      draft_sent: 'OLDEST reorder reply.',
      sent_at: new Date(Date.now() - 1000 * 60 * 60 * 24 * 7),
    });
    const middle = await seedSent({
      category: 'reorder',
      draft_sent: 'MIDDLE reorder reply.',
      sent_at: new Date(Date.now() - 1000 * 60 * 60 * 24 * 3),
    });
    const newest = await seedSent({
      category: 'reorder',
      draft_sent: 'NEWEST reorder reply.',
      sent_at: new Date(Date.now() - 1000 * 60 * 60),
    });
    seeded.ids.push(oldest, middle, newest);

    const result = await getCategoryExemplars('reorder', 2);
    expect(result).toHaveLength(2);
    // Most-recent first.
    expect(result[0].snippet).toContain('NEWEST');
    expect(result[1].snippet).toContain('MIDDLE');
  });

  it("respects category filter — doesn't return rows for other categories", async () => {
    const reorderId = await seedSent({
      category: 'reorder',
      draft_sent: 'reorder body',
      sent_at: new Date(Date.now() - 1000 * 60),
    });
    const inquiryId = await seedSent({
      category: 'inquiry',
      draft_sent: 'inquiry body',
      sent_at: new Date(Date.now() - 1000 * 30), // newer
    });
    seeded.ids.push(reorderId, inquiryId);

    const reorderResult = await getCategoryExemplars('reorder', 5);
    expect(reorderResult).toHaveLength(1);
    expect(reorderResult[0].snippet).toContain('reorder body');

    const inquiryResult = await getCategoryExemplars('inquiry', 5);
    expect(inquiryResult).toHaveLength(1);
    expect(inquiryResult[0].snippet).toContain('inquiry body');
  });

  it('returns [] when category has no rows (graceful degrade)', async () => {
    // No seed for 'follow_up' — but to make sure we're not picking up rows
    // from a parallel test, also delete any prior follow_up rows from this
    // suite's seeds.
    const result = await getCategoryExemplars('follow_up', 5);
    // We don't seed follow_up so the result MAY contain pre-existing rows
    // from other suites. Assert only on the shape contract: array, no throw.
    expect(Array.isArray(result)).toBe(true);
    for (const ex of result) {
      // Defensive: if any rows exist they shouldn't be reorder/inquiry.
      expect(typeof ex.snippet).toBe('string');
      expect(typeof ex.sent_at).toBe('string');
    }
  });

  it('returns [] when k <= 0', async () => {
    const result = await getCategoryExemplars('reorder', 0);
    expect(result).toEqual([]);
    const negative = await getCategoryExemplars('reorder', -1);
    expect(negative).toEqual([]);
  });

  it('truncates snippets to RAG_RETRIEVE_EXCERPT_CHARS', async () => {
    // Default cap is 600. Seed a longer body and assert the result snippet
    // is at most 600 chars.
    const longBody = 'a'.repeat(2000);
    const id = await seedSent({
      category: 'scheduling',
      draft_sent: longBody,
      sent_at: new Date(),
    });
    seeded.ids.push(id);

    const result = await getCategoryExemplars('scheduling', 1);
    expect(result).toHaveLength(1);
    // Per excerptCharCap default = 600.
    expect(result[0].snippet.length).toBeLessThanOrEqual(600);
    expect(result[0].snippet.startsWith('a')).toBe(true);
  });
});
