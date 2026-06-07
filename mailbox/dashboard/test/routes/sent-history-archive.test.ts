import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { closeTestPool, deleteSeededDraft, getTestPool, HAS_DB, seedDraft } from '../helpers/db';

// STAQPRO-189 — sent_history archival trigger contract.
//
// The archival path is implemented Postgres-side (migration 010): an
// AFTER UPDATE trigger on mailbox.drafts that copies the row into
// mailbox.sent_history when status flips to 'sent'. We test the trigger
// directly against the canonical schema fixture rather than going through
// the n8n send path — same reasoning as the schema-invariants tests, the
// constraint and trigger are the source of truth.

const dbDescribe = HAS_DB ? describe : describe.skip;

dbDescribe('sent_history archive trigger — STAQPRO-189', () => {
  const cleanup: Array<() => Promise<void>> = [];

  afterEach(async () => {
    while (cleanup.length > 0) {
      const fn = cleanup.pop();
      if (fn) await fn().catch(() => undefined);
    }
  });

  afterAll(async () => {
    await closeTestPool();
  });

  it('inserts a sent_history row when drafts.status flips to sent', async () => {
    const pool = getTestPool();
    const seed = await seedDraft({ status: 'pending', classification: 'reorder' });
    cleanup.push(async () => {
      await pool.query('DELETE FROM mailbox.sent_history WHERE draft_id = $1', [seed.draftId]);
      await deleteSeededDraft(seed);
    });

    // Stamp the columns the trigger needs — the seed helper sets some but
    // not draft_source / classification_confidence — flip status to 'sent'.
    await pool.query(
      `UPDATE mailbox.drafts
         SET draft_source = 'local',
             classification_confidence = 0.92,
             sent_at = NOW(),
             status = 'sent'
         WHERE id = $1`,
      [seed.draftId],
    );

    const r = await pool.query(
      `SELECT draft_id, draft_source, classification_category, classification_confidence,
              from_addr, to_addr, draft_sent
         FROM mailbox.sent_history
         WHERE draft_id = $1`,
      [seed.draftId],
    );
    expect(r.rowCount).toBe(1);
    const row = r.rows[0];
    expect(row.draft_id).toBe(seed.draftId);
    expect(row.draft_source).toBe('local');
    expect(row.classification_category).toBe('reorder');
    expect(Number(row.classification_confidence)).toBeCloseTo(0.92, 2);
    expect(row.from_addr).toBe('sender@example.com');
    expect(row.to_addr).toBe('op@example.com');
    expect(row.draft_sent).toBeTruthy();
  });

  it('accepts both local and cloud draft_source (constraint widened)', async () => {
    const pool = getTestPool();
    const seed = await seedDraft({ status: 'pending', classification: 'escalate' });
    cleanup.push(async () => {
      await pool.query('DELETE FROM mailbox.sent_history WHERE draft_id = $1', [seed.draftId]);
      await deleteSeededDraft(seed);
    });

    await pool.query(
      `UPDATE mailbox.drafts
         SET draft_source = 'cloud',
             classification_confidence = 0.55,
             sent_at = NOW(),
             status = 'sent'
         WHERE id = $1`,
      [seed.draftId],
    );

    const r = await pool.query(
      `SELECT draft_source FROM mailbox.sent_history WHERE draft_id = $1`,
      [seed.draftId],
    );
    expect(r.rowCount).toBe(1);
    expect(r.rows[0].draft_source).toBe('cloud');
  });

  it('is idempotent on duplicate transition (re-flip to sent)', async () => {
    const pool = getTestPool();
    const seed = await seedDraft({ status: 'pending', classification: 'reorder' });
    cleanup.push(async () => {
      await pool.query('DELETE FROM mailbox.sent_history WHERE draft_id = $1', [seed.draftId]);
      await deleteSeededDraft(seed);
    });

    await pool.query(
      `UPDATE mailbox.drafts
         SET draft_source = 'local', classification_confidence = 0.9,
             sent_at = NOW(), status = 'sent'
         WHERE id = $1`,
      [seed.draftId],
    );
    // Bounce status away from sent and back to sent — second transition
    // should not create a duplicate sent_history row (idempotency guard).
    // Trigger fires on IS DISTINCT FROM 'sent', so any non-sent value works
    // as the bounce target; 'rejected' is a valid CHECK value (post-016).
    await pool.query(`UPDATE mailbox.drafts SET status = 'rejected' WHERE id = $1`, [seed.draftId]);
    await pool.query(`UPDATE mailbox.drafts SET status = 'sent' WHERE id = $1`, [seed.draftId]);

    const r = await pool.query(
      `SELECT COUNT(*)::int AS c FROM mailbox.sent_history WHERE draft_id = $1`,
      [seed.draftId],
    );
    expect(r.rows[0].c).toBe(1);
  });

  it('does not insert when status changes to anything other than sent', async () => {
    const pool = getTestPool();
    const seed = await seedDraft({ status: 'pending', classification: 'reorder' });
    cleanup.push(async () => {
      await pool.query('DELETE FROM mailbox.sent_history WHERE draft_id = $1', [seed.draftId]);
      await deleteSeededDraft(seed);
    });

    await pool.query(`UPDATE mailbox.drafts SET status = 'rejected' WHERE id = $1`, [seed.draftId]);

    const r = await pool.query(
      `SELECT COUNT(*)::int AS c FROM mailbox.sent_history WHERE draft_id = $1`,
      [seed.draftId],
    );
    expect(r.rows[0].c).toBe(0);
  });
});
