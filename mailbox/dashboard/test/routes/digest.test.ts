import { afterAll, afterEach, describe, expect, it } from 'vitest';
import {
  getDigestPayload,
  hasDigestSentOn,
  recordDigestSendIfFirstToday,
} from '@/lib/queries-digest';
import type { DraftStatus } from '@/lib/types';
import { closeTestPool, getTestPool, HAS_DB } from '../helpers/db';

// MBOX-132 — DB-backed tests for the digest payload query + the once-per-day
// de-dupe ledger. Seeds drafts directly with raw SQL (mirrors urgency.test.ts)
// so we control from_addr / created_at / category / confidence / status. Each
// seeded draft carries a unique marker tag for parallel-safe cleanup.

const dbDescribe = HAS_DB ? describe : describe.skip;

const TAG = `digesttest-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
let seq = 0;

interface SeedOpts {
  status?: DraftStatus;
  category?: string | null;
  confidence?: number | null;
  fromAddr?: string;
  ageHours?: number;
}

async function seedDraft(opts: SeedOpts = {}): Promise<number> {
  const pool = getTestPool();
  const status = opts.status ?? 'pending';
  const category = opts.category === undefined ? 'inquiry' : opts.category;
  const confidence = opts.confidence === undefined ? 0.95 : opts.confidence;
  const fromAddr = opts.fromAddr ?? 'normal@example.com';
  const ageHours = opts.ageHours ?? 0.05;
  const messageId = `${TAG}-${++seq}`;

  // inbox_messages carries the denormalized classification the digest reads for
  // the urgent-untouched category field; set it to match the draft category.
  const inbox = await pool.query<{ id: number }>(
    `INSERT INTO mailbox.inbox_messages
       (message_id, from_addr, to_addr, subject, snippet, body, classification, received_at)
     VALUES ($1, $2, 'op@example.com', $3, 'a short preview', 'body', $4, NOW())
     RETURNING id`,
    [messageId, fromAddr, `subj ${messageId}`, category],
  );

  const draft = await pool.query<{ id: number }>(
    `INSERT INTO mailbox.drafts
       (inbox_message_id, draft_body, draft_subject, model, status,
        classification_category, classification_confidence, from_addr, subject, created_at)
     VALUES ($1, 'draft body', $2, 'qwen3:4b-ctx4k', $3, $4, $5, $6, $7,
             NOW() - ($8 || ' hours')::interval)
     RETURNING id`,
    [
      inbox.rows[0].id,
      `subj ${messageId}`,
      status,
      category,
      confidence,
      fromAddr,
      `subj ${messageId}`,
      String(ageHours),
    ],
  );
  return draft.rows[0].id;
}

dbDescribe('digest payload + de-dupe ledger — real Postgres', () => {
  afterEach(async () => {
    const pool = getTestPool();
    await pool.query(
      `DELETE FROM mailbox.drafts WHERE inbox_message_id IN
         (SELECT id FROM mailbox.inbox_messages WHERE message_id LIKE $1)`,
      [`${TAG}-%`],
    );
    await pool.query('DELETE FROM mailbox.inbox_messages WHERE message_id LIKE $1', [`${TAG}-%`]);
    await pool.query("DELETE FROM mailbox.digest_sends WHERE sent_on >= '2999-01-01'");
  });

  afterAll(async () => {
    await closeTestPool();
  });

  it('getDigestPayload groups counts by category over the queue slice', async () => {
    await seedDraft({ category: 'inquiry', confidence: 0.99 });
    await seedDraft({ category: 'inquiry', confidence: 0.99 });
    await seedDraft({ category: 'reorder', confidence: 0.99 });
    await seedDraft({ category: 'inquiry', status: 'edited', confidence: 0.99 });
    // 'sent' is out of the queue slice — must not appear in counts.
    await seedDraft({ category: 'scheduling', status: 'sent', confidence: 0.99 });

    const payload = await getDigestPayload({ env: {} });
    const counts = new Map(payload.counts_by_category.map((c) => [c.category, c.count]));

    // Counts are global; assert our seeded categories are present at >= our seed.
    expect(counts.get('inquiry') ?? 0).toBeGreaterThanOrEqual(3); // 2 pending + 1 edited
    expect(counts.get('reorder') ?? 0).toBeGreaterThanOrEqual(1);
    // scheduling 'sent' row must not be counted by our seeds — can't assert
    // global absence, but the slice excludes 'sent' (covered by status filter).
  });

  it('getDigestPayload.urgent_untouched reuses the urgency engine (escalate fires)', async () => {
    const escalateId = await seedDraft({ category: 'escalate', confidence: 0.99 });
    const calmId = await seedDraft({ category: 'inquiry', confidence: 0.99, ageHours: 0.1 });

    const payload = await getDigestPayload({ env: {} });
    const urgentIds = new Set(payload.urgent_untouched.map((u) => u.draft_id));

    expect(urgentIds.has(escalateId)).toBe(true);
    expect(urgentIds.has(calmId)).toBe(false);

    const escalateItem = payload.urgent_untouched.find((u) => u.draft_id === escalateId);
    expect(escalateItem?.signals).toContain('escalate');
    expect(escalateItem?.category).toBe('escalate');
  });

  it('getDigestPayload.urgent_untouched flags an aged pending draft', async () => {
    const agedId = await seedDraft({ category: 'inquiry', confidence: 0.99, ageHours: 10 });
    const payload = await getDigestPayload({ env: {} });
    const item = payload.urgent_untouched.find((u) => u.draft_id === agedId);
    expect(item?.signals).toContain('aged');
  });

  it('getDigestPayload.oldest_pending returns oldest pending first', async () => {
    const old = await seedDraft({ category: 'inquiry', confidence: 0.99, ageHours: 48 });
    const newer = await seedDraft({ category: 'inquiry', confidence: 0.99, ageHours: 1 });

    const payload = await getDigestPayload({ env: {}, oldestLimit: 50 });
    const ours = payload.oldest_pending.filter((p) => p.draft_id === old || p.draft_id === newer);
    const oldIdx = ours.findIndex((p) => p.draft_id === old);
    const newIdx = ours.findIndex((p) => p.draft_id === newer);
    expect(oldIdx).toBeGreaterThanOrEqual(0);
    expect(newIdx).toBeGreaterThanOrEqual(0);
    // older draft comes before the newer one (FIFO)
    expect(oldIdx).toBeLessThan(newIdx);
    // age is computed and positive
    expect(ours[oldIdx].age_hours).toBeGreaterThan(ours[newIdx].age_hours);
  });

  // ── de-dupe ledger ─────────────────────────────────────────────────────
  // Use a far-future sentinel day so we never collide with a real ledger row.
  const DAY = '2999-12-31';

  it('recordDigestSendIfFirstToday claims the day once, then no-ops', async () => {
    expect(await hasDigestSentOn(DAY)).toBe(false);

    const first = await recordDigestSendIfFirstToday({
      sent_on: DAY,
      recipient: 'op@example.com',
      subject: 'digest',
    });
    expect(first).toBe(true); // we claimed it
    expect(await hasDigestSentOn(DAY)).toBe(true);

    // Second call for the same day is suppressed by UNIQUE(sent_on).
    const second = await recordDigestSendIfFirstToday({
      sent_on: DAY,
      recipient: 'op@example.com',
      subject: 'digest re-fire',
    });
    expect(second).toBe(false); // already claimed → idempotent skip
  });

  it('de-dupe guard is per-day — a different day claims independently', async () => {
    const dayA = '2999-12-30';
    const dayB = '2999-12-29';
    expect(
      await recordDigestSendIfFirstToday({ sent_on: dayA, recipient: null, subject: null }),
    ).toBe(true);
    expect(
      await recordDigestSendIfFirstToday({ sent_on: dayB, recipient: null, subject: null }),
    ).toBe(true);
    expect(
      await recordDigestSendIfFirstToday({ sent_on: dayA, recipient: null, subject: null }),
    ).toBe(false);
  });
});
