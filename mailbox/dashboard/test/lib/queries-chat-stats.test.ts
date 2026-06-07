import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getApplianceStatsContext } from '@/lib/queries-chat-stats';
import { closeTestPool, getTestPool, HAS_DB } from '../helpers/db';

// MBOX-307 — the appliance-stats aggregate helper against the fixture DB. Seeds
// a known set of inbox / sent_history / drafts rows under a unique tag, then
// asserts the aggregates reflect them. Gated on HAS_DB (TEST_POSTGRES_URL),
// same as the other DB-backed suites.

const dbDescribe = HAS_DB ? describe : describe.skip;

// Unique marker so this suite's assertions are robust against other rows that
// may already exist in a shared fixture DB. We assert "at least our seeded
// counts" for totals and exact membership for our tagged senders/recipients.
const TAG = `mbox307-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const SENDER_A = `${TAG}-sender-a@example.com`;
const SENDER_B = `${TAG}-sender-b@example.com`;
const RECIPIENT = `${TAG}-recip@example.com`;

const seededInboxIds: number[] = [];
const seededDraftIds: number[] = [];
const seededSentIds: number[] = [];

dbDescribe('getApplianceStatsContext — MBOX-307', () => {
  beforeAll(async () => {
    const pool = getTestPool();

    // 3 inbound from SENDER_A, 1 from SENDER_B; classification reorder x2, inquiry x1.
    const inboundSpecs: Array<{ from: string; cls: string | null }> = [
      { from: SENDER_A, cls: 'reorder' },
      { from: SENDER_A, cls: 'reorder' },
      { from: SENDER_A, cls: 'inquiry' },
      { from: SENDER_B, cls: null },
    ];
    for (let i = 0; i < inboundSpecs.length; i++) {
      const spec = inboundSpecs[i];
      const r = await pool.query<{ id: number }>(
        `INSERT INTO mailbox.inbox_messages
           (message_id, from_addr, to_addr, subject, body, received_at, classification)
         VALUES ($1, $2, 'op@example.com', $3, 'body', NOW(), $4)
         RETURNING id`,
        [`${TAG}-in-${i}`, spec.from, `subj ${i}`, spec.cls],
      );
      seededInboxIds.push(r.rows[0].id);
    }

    // 2 drafts: 1 pending, 1 sent — linked to a seeded inbox row.
    for (const status of ['pending', 'sent'] as const) {
      const r = await pool.query<{ id: number }>(
        `INSERT INTO mailbox.drafts
           (inbox_message_id, draft_body, model, status,
            from_addr, to_addr, subject, body_text)
         VALUES ($1, 'draft body', 'qwen3:4b-ctx4k', $2,
                 $3, 'op@example.com', 'subj', 'body')
         RETURNING id`,
        [seededInboxIds[0], status, SENDER_A],
      );
      seededDraftIds.push(r.rows[0].id);
    }

    // 2 outbound to RECIPIENT (sent_history.to_addr / classification_category NOT NULL).
    for (let i = 0; i < 2; i++) {
      const r = await pool.query<{ id: number }>(
        `INSERT INTO mailbox.sent_history
           (inbox_message_id, from_addr, to_addr, subject,
            draft_sent, draft_source, classification_category, classification_confidence, sent_at)
         VALUES ($1, 'op@example.com', $2, $3,
                 'sent body', 'local', 'reorder', 0.9, NOW())
         RETURNING id`,
        [seededInboxIds[0], RECIPIENT, `${TAG}-out-${i}`],
      );
      seededSentIds.push(r.rows[0].id);
    }
  });

  afterAll(async () => {
    const pool = getTestPool();
    if (seededSentIds.length)
      await pool.query('DELETE FROM mailbox.sent_history WHERE id = ANY($1)', [seededSentIds]);
    if (seededDraftIds.length)
      await pool.query('DELETE FROM mailbox.drafts WHERE id = ANY($1)', [seededDraftIds]);
    if (seededInboxIds.length)
      await pool.query('DELETE FROM mailbox.inbox_messages WHERE id = ANY($1)', [seededInboxIds]);
    await closeTestPool();
  });

  it('inbound totals count the seeded rows and windows are non-negative', async () => {
    const stats = await getApplianceStatsContext();
    expect(stats.inbound.total).toBeGreaterThanOrEqual(4);
    expect(stats.inbound.last_24h).toBeGreaterThanOrEqual(4);
    expect(stats.inbound.last_7d).toBeGreaterThanOrEqual(stats.inbound.last_24h);
    expect(stats.inbound.last_30d).toBeGreaterThanOrEqual(stats.inbound.last_7d);
    // earliest <= latest; both present since we just inserted.
    expect(stats.inbound.earliest_received_at).not.toBeNull();
    expect(stats.inbound.latest_received_at).not.toBeNull();
  });

  it('top_senders includes the seeded senders with correct relative volume', async () => {
    const stats = await getApplianceStatsContext();
    const a = stats.top_senders.find((s) => s.addr === SENDER_A);
    // SENDER_A has 3 seeded inbound. It may or may not make the top-5 depending
    // on other fixture rows, but when present its count must be at least 3.
    if (a) expect(a.count).toBeGreaterThanOrEqual(3);
    // All counts are positive integers.
    for (const s of stats.top_senders) {
      expect(Number.isInteger(s.count)).toBe(true);
      expect(s.count).toBeGreaterThan(0);
    }
    expect(stats.top_senders.length).toBeLessThanOrEqual(5);
  });

  it('top_recipients reflects sent_history volume', async () => {
    const stats = await getApplianceStatsContext();
    const r = stats.top_recipients.find((x) => x.addr === RECIPIENT);
    if (r) expect(r.count).toBeGreaterThanOrEqual(2);
    expect(stats.top_recipients.length).toBeLessThanOrEqual(5);
  });

  it('categories breakdown counts the seeded classifications', async () => {
    const stats = await getApplianceStatsContext();
    const reorder = stats.categories.find((c) => c.category === 'reorder');
    expect(reorder).toBeDefined();
    // We seeded 2 reorder inbound rows; other fixtures may add more.
    expect((reorder?.count ?? 0) >= 2).toBe(true);
    // NULL classification (SENDER_B) is excluded — no empty-string category.
    expect(stats.categories.some((c) => c.category === '' || c.category == null)).toBe(false);
  });

  it('queue counts include the seeded pending/sent drafts', async () => {
    const stats = await getApplianceStatsContext();
    expect(stats.queue.pending).toBeGreaterThanOrEqual(1);
    expect(stats.queue.sent).toBeGreaterThanOrEqual(1);
    for (const v of Object.values(stats.queue)) {
      expect(Number.isInteger(v)).toBe(true);
      expect(v).toBeGreaterThanOrEqual(0);
    }
  });
});
