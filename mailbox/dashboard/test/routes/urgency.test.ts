import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { countUrgentDrafts, getQueueWithUrgency } from '@/lib/queries';
import type { DraftStatus } from '@/lib/types';
import { closeTestPool, fakeRequest, getTestPool, HAS_DB } from '../helpers/db';

// MBOX-134 — DB-backed tests for the urgency SQL surface (getQueueWithUrgency,
// countUrgentDrafts) plus the VIP routes and the urgent-count route. Seeds
// drafts directly with raw SQL so we control from_addr / created_at /
// classification_category / classification_confidence / status — the seedDraft
// helper doesn't expose those. Each seeded draft carries a unique marker tag so
// the suite cleans up only its own rows and tolerates parallel runs.

const dbDescribe = HAS_DB ? describe : describe.skip;

const TAG = `urgtest-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
let seq = 0;

interface SeedUrgencyOpts {
  status?: DraftStatus;
  category?: string | null;
  confidence?: number | null;
  fromAddr?: string;
  ageHours?: number; // created_at = NOW() - ageHours
}

async function seedUrgencyDraft(opts: SeedUrgencyOpts = {}): Promise<number> {
  const pool = getTestPool();
  const status = opts.status ?? 'pending';
  const category = opts.category === undefined ? 'inquiry' : opts.category;
  const confidence = opts.confidence === undefined ? 0.95 : opts.confidence;
  const fromAddr = opts.fromAddr ?? 'normal@example.com';
  const ageHours = opts.ageHours ?? 0.05;
  const messageId = `${TAG}-${++seq}`;

  const inbox = await pool.query<{ id: number }>(
    `INSERT INTO mailbox.inbox_messages (message_id, from_addr, to_addr, subject, body, received_at)
     VALUES ($1, $2, 'op@example.com', $3, 'body', NOW())
     RETURNING id`,
    [messageId, fromAddr, `subj ${messageId}`],
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

dbDescribe('urgency SQL surface + VIP routes — real Postgres', () => {
  beforeAll(async () => {
    // Clean any stray VIP test rows up-front (defensive against a prior crash).
    const pool = getTestPool();
    await pool.query("DELETE FROM mailbox.vip_senders WHERE email_or_domain LIKE 'viptest-%'");
  });

  afterEach(async () => {
    const pool = getTestPool();
    // Cascade-clean seeded drafts + their inbox rows (drafts FK inbox).
    await pool.query(
      `DELETE FROM mailbox.drafts WHERE inbox_message_id IN
         (SELECT id FROM mailbox.inbox_messages WHERE message_id LIKE $1)`,
      [`${TAG}-%`],
    );
    await pool.query('DELETE FROM mailbox.inbox_messages WHERE message_id LIKE $1', [`${TAG}-%`]);
    await pool.query("DELETE FROM mailbox.vip_senders WHERE email_or_domain LIKE 'viptest-%'");
  });

  afterAll(async () => {
    await closeTestPool();
  });

  it('getQueueWithUrgency flags escalate, low_conf, and aged signals from SQL', async () => {
    const escalateId = await seedUrgencyDraft({ category: 'escalate' });
    const lowConfId = await seedUrgencyDraft({ confidence: 0.4 });
    const agedId = await seedUrgencyDraft({ category: 'inquiry', ageHours: 10 });
    const calmId = await seedUrgencyDraft({ category: 'inquiry', confidence: 0.99, ageHours: 0.1 });

    const rows = await getQueueWithUrgency(['pending'], 200, {});
    const byId = new Map(rows.map((r) => [r.id, r.urgency]));

    expect(byId.get(escalateId)?.signals).toContain('escalate');
    expect(byId.get(escalateId)?.urgent).toBe(true);
    expect(byId.get(lowConfId)?.signals).toContain('low_conf');
    expect(byId.get(agedId)?.signals).toContain('aged');
    expect(byId.get(calmId)?.urgent).toBe(false);
    expect(byId.get(calmId)?.signals).toEqual([]);
  });

  it('getQueueWithUrgency flags vip by exact email and by domain suffix', async () => {
    const pool = getTestPool();
    await pool.query(
      `INSERT INTO mailbox.vip_senders (email_or_domain, kind) VALUES
         ('viptest-ceo@acme.test', 'email'),
         ('viptest-corp.test', 'domain')`,
    );

    const emailHit = await seedUrgencyDraft({
      fromAddr: 'viptest-ceo@acme.test',
      confidence: 0.99,
    });
    const domainHit = await seedUrgencyDraft({
      fromAddr: 'anyone@viptest-corp.test',
      confidence: 0.99,
    });
    const noHit = await seedUrgencyDraft({ fromAddr: 'stranger@other.test', confidence: 0.99 });

    const rows = await getQueueWithUrgency(['pending'], 200, {});
    const byId = new Map(rows.map((r) => [r.id, r.urgency]));

    expect(byId.get(emailHit)?.signals).toContain('vip');
    expect(byId.get(domainHit)?.signals).toContain('vip');
    expect(byId.get(noHit)?.signals ?? []).not.toContain('vip');
  });

  it('aged honors an env threshold override', async () => {
    const agedAt2h = await seedUrgencyDraft({ category: 'inquiry', ageHours: 2, confidence: 0.99 });

    // Default 4h → not aged at 2h.
    const defaultRows = await getQueueWithUrgency(['pending'], 200, {});
    expect(defaultRows.find((r) => r.id === agedAt2h)?.urgency.signals ?? []).not.toContain('aged');

    // Override to 1h → aged at 2h.
    const overrideRows = await getQueueWithUrgency(['pending'], 200, {
      URGENCY_AGE_HOURS_INQUIRY: '1',
    });
    expect(overrideRows.find((r) => r.id === agedAt2h)?.urgency.signals).toContain('aged');
  });

  it('countUrgentDrafts counts only drafts that fire at least one signal', async () => {
    await seedUrgencyDraft({ category: 'escalate' }); // urgent
    await seedUrgencyDraft({ confidence: 0.4 }); // urgent (low_conf)
    await seedUrgencyDraft({ category: 'inquiry', confidence: 0.99, ageHours: 0.1 }); // calm

    // Scope the assertion to our seeded rows by diffing — other suites may have
    // left pending rows. Count urgent among only our tag via a direct check.
    const pool = getTestPool();
    const { rows: ours } = await pool.query<{ n: string }>(
      `SELECT COUNT(*) AS n FROM mailbox.drafts d
         JOIN mailbox.inbox_messages m ON m.id = d.inbox_message_id
        WHERE m.message_id LIKE $1
          AND d.status = 'pending'
          AND (
            d.classification_category = 'escalate'
            OR d.classification_confidence IS NULL
            OR d.classification_confidence < 0.75
          )`,
      [`${TAG}-%`],
    );
    expect(Number(ours[0].n)).toBe(2);

    // countUrgentDrafts is a global count; assert it's at least our 2 urgent.
    const total = await countUrgentDrafts(['pending'], {});
    expect(total).toBeGreaterThanOrEqual(2);
  });

  it('GET /api/queue/urgent-count returns { count } as a number', async () => {
    await seedUrgencyDraft({ category: 'escalate' });
    const { GET } = await import('@/app/api/queue/urgent-count/route');
    const res = await GET();
    expect(res.status).toBe(200);
    const body = (await res.json()) as { count: number };
    expect(typeof body.count).toBe('number');
    expect(body.count).toBeGreaterThanOrEqual(1);
  });

  it('POST /api/vip-senders adds an entry, lowercases it, and is idempotent', async () => {
    const { POST, GET } = await import('@/app/api/vip-senders/route');

    const res1 = await POST(
      fakeRequest({ body: { email_or_domain: 'VIPtest-CEO@Acme.test', kind: 'email' } }),
    );
    expect(res1.status).toBe(200);
    const body1 = (await res1.json()) as { sender: { id: number; email_or_domain: string } };
    expect(body1.sender.email_or_domain).toBe('viptest-ceo@acme.test');

    // Re-add same value+kind → upsert, same id, no duplicate.
    const res2 = await POST(
      fakeRequest({
        body: { email_or_domain: 'viptest-ceo@acme.test', kind: 'email', note: 'vip' },
      }),
    );
    expect(res2.status).toBe(200);
    const body2 = (await res2.json()) as { sender: { id: number; note: string | null } };
    expect(body2.sender.id).toBe(body1.sender.id);
    expect(body2.sender.note).toBe('vip');

    const listRes = await GET();
    const list = (await listRes.json()) as { senders: Array<{ email_or_domain: string }> };
    const mine = list.senders.filter((s) => s.email_or_domain === 'viptest-ceo@acme.test');
    expect(mine).toHaveLength(1);
  });

  it('POST /api/vip-senders rejects a non-email value when kind=email (zod 400)', async () => {
    const { POST } = await import('@/app/api/vip-senders/route');
    const res = await POST(
      fakeRequest({ body: { email_or_domain: 'viptest-not-an-email', kind: 'email' } }),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('validation_failed');
  });

  it('POST /api/vip-senders rejects an invalid kind (zod 400)', async () => {
    const { POST } = await import('@/app/api/vip-senders/route');
    const res = await POST(
      fakeRequest({ body: { email_or_domain: 'viptest-corp.test', kind: 'regex' } }),
    );
    expect(res.status).toBe(400);
  });

  it('DELETE /api/vip-senders/[id] removes a row, 404s on missing', async () => {
    const { POST } = await import('@/app/api/vip-senders/route');
    const { DELETE } = await import('@/app/api/vip-senders/[id]/route');

    const created = await POST(
      fakeRequest({ body: { email_or_domain: 'viptest-del.test', kind: 'domain' } }),
    );
    const { sender } = (await created.json()) as { sender: { id: number } };

    const delRes = await DELETE(fakeRequest(), {
      params: Promise.resolve({ id: String(sender.id) }),
    });
    expect(delRes.status).toBe(200);
    const delBody = (await delRes.json()) as { deleted: boolean; id: number };
    expect(delBody.deleted).toBe(true);

    const again = await DELETE(fakeRequest(), {
      params: Promise.resolve({ id: String(sender.id) }),
    });
    expect(again.status).toBe(404);
  });
});
