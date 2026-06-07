import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { reclassifyBySender } from '@/lib/queries-sender-allowlist';
import { closeTestPool, getTestPool, HAS_DB } from '../helpers/db';

// MBOX-370 — real-Postgres integration tests for "reclassify automatically".
//
// reclassifyBySender re-runs the REAL classifier (classifyOne) per email. We
// inject a fake fetch (classifyOne's deps.fetchImpl) so the test doesn't need a
// live Ollama — the fake returns a canned /api/generate body, letting us drive
// both the spam-surfaced path and the natural non-spam path deterministically.
//
// Asserts: the sender is added to mailbox.sender_never_spam; existing emails are
// re-classified (the migration-021 trigger syncs inbox_messages off each
// classification_log insert); a model spam verdict is SURFACED to unknown (never
// dropped) because the sender is allowlisted; a non-spam verdict passes through;
// the allowlist upsert is idempotent.
const dbDescribe = HAS_DB ? describe : describe.skip;

const SENDER = 'vendor-370@example.com';
const HEADER_FORM = `"Vendor Newsletter" <${SENDER}>`;

// A fake Ollama /api/generate that always returns the given classifier JSON.
function fakeLlm(category: string, confidence = 0.9): typeof fetch {
  return (async () =>
    new Response(JSON.stringify({ response: JSON.stringify({ category, confidence }) }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })) as unknown as typeof fetch;
}

async function seedInbox(messageId: string, fromAddr: string): Promise<number> {
  const pool = getTestPool();
  const r = await pool.query<{ id: number }>(
    `INSERT INTO mailbox.inbox_messages
       (message_id, from_addr, to_addr, subject, body, received_at)
     VALUES ($1, $2, 'op@example.com', $3, 'please send a quote', NOW())
     RETURNING id`,
    [messageId, fromAddr, `subj ${messageId}`],
  );
  return r.rows[0].id;
}

async function cleanup(): Promise<void> {
  const pool = getTestPool();
  await pool.query(
    `DELETE FROM mailbox.classification_log
      WHERE inbox_message_id IN
        (SELECT id FROM mailbox.inbox_messages WHERE message_id LIKE 'mbox370-%')`,
  );
  await pool.query("DELETE FROM mailbox.inbox_messages WHERE message_id LIKE 'mbox370-%'");
  await pool.query('DELETE FROM mailbox.sender_never_spam WHERE email = $1', [SENDER]);
}

dbDescribe('reclassifyBySender (MBOX-370) — real Postgres', () => {
  afterEach(cleanup);
  afterAll(closeTestPool);

  it('allowlists the sender and SURFACES a model spam verdict to unknown across all their mail (incl. "Name <addr>")', async () => {
    const pool = getTestPool();
    const m1 = await seedInbox('mbox370-1', SENDER);
    const m2 = await seedInbox('mbox370-2', HEADER_FORM);

    const res = await reclassifyBySender({
      email: SENDER,
      reason: 'legit vendor',
      deps: { fetchImpl: fakeLlm('spam_marketing') },
    });

    expect(res.allowlisted).toBe(true);
    expect(res.reclassified).toBe(2);
    expect(res.surfaced).toBe(2); // both spam verdicts surfaced (sender allowlisted)
    expect(res.truncated).toBe(false);

    // Allowlist row exists.
    const allow = await pool.query<{ n: string }>(
      'SELECT count(*) AS n FROM mailbox.sender_never_spam WHERE email = $1',
      [SENDER],
    );
    expect(Number(allow.rows[0].n)).toBe(1);

    // Both messages re-classified to unknown (surfaced, NOT spam_marketing) — the
    // migration-021 trigger synced inbox_messages off the classification_log insert.
    const inbox = await pool.query<{ classification: string }>(
      'SELECT classification FROM mailbox.inbox_messages WHERE id IN ($1, $2)',
      [m1, m2],
    );
    expect(inbox.rows.map((r) => r.classification)).toEqual(['unknown', 'unknown']);

    // Latest classification_log row per message is unknown, not spam.
    const log = await pool.query<{ category: string }>(
      `SELECT DISTINCT ON (inbox_message_id) category
         FROM mailbox.classification_log
        WHERE inbox_message_id IN ($1, $2)
        ORDER BY inbox_message_id, id DESC`,
      [m1, m2],
    );
    expect(log.rows.every((r) => r.category === 'unknown')).toBe(true);
  });

  it('passes a non-spam model verdict through unchanged (surfaced=0)', async () => {
    const pool = getTestPool();
    const m1 = await seedInbox('mbox370-1', SENDER);

    const res = await reclassifyBySender({
      email: SENDER,
      reason: null,
      deps: { fetchImpl: fakeLlm('inquiry') },
    });
    expect(res.reclassified).toBe(1);
    expect(res.surfaced).toBe(0);

    const inbox = await pool.query<{ classification: string }>(
      'SELECT classification FROM mailbox.inbox_messages WHERE id = $1',
      [m1],
    );
    expect(inbox.rows[0].classification).toBe('inquiry');
  });

  it('is idempotent — re-running upserts the allowlist row, never duplicates', async () => {
    await seedInbox('mbox370-1', SENDER);
    await reclassifyBySender({
      email: SENDER,
      reason: null,
      deps: { fetchImpl: fakeLlm('inquiry') },
    });
    await reclassifyBySender({
      email: SENDER,
      reason: 'second pass',
      deps: { fetchImpl: fakeLlm('inquiry') },
    });

    const pool = getTestPool();
    const allow = await pool.query<{ n: string; reason: string }>(
      'SELECT count(*) AS n, max(reason) AS reason FROM mailbox.sender_never_spam WHERE email = $1',
      [SENDER],
    );
    expect(Number(allow.rows[0].n)).toBe(1);
    expect(allow.rows[0].reason).toBe('second pass'); // upsert updated the note
  });
});
