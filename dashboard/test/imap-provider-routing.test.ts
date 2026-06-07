// MBOX-357 (P1 T5) — IMAP ingress/egress wiring that's pure (no DB / no
// network): the inbox-messages `provider` discriminator on the ingest schema
// and the provider→webhook routing in lib/n8n.ts. The DB-backed pieces
// (getMailCooldown, the inbox-messages normalize branch, getDraftProviderContext)
// are covered under the HAS_DB-gated suites; the IMAP normalize/thread synthesis
// itself is covered by lib/mail/providers/__tests__/imap.test.ts.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { triggerSendWebhook } from '@/lib/n8n';
import { inboxMessageInsertBodySchema } from '@/lib/schemas/internal';

describe('inboxMessageInsertBodySchema — provider discriminator', () => {
  it('defaults provider to gmail when omitted (the un-changed live Gmail path)', () => {
    const parsed = inboxMessageInsertBodySchema.parse({ message_id: 'abc' });
    expect(parsed.provider).toBe('gmail');
  });

  it('accepts the imap provider sent by MailBOX-Imap', () => {
    const parsed = inboxMessageInsertBodySchema.parse({ message_id: 'abc', provider: 'imap' });
    expect(parsed.provider).toBe('imap');
  });

  it('rejects an unknown transport (closed set = MAIL_PROVIDERS)', () => {
    expect(() =>
      inboxMessageInsertBodySchema.parse({ message_id: 'abc', provider: 'pop3' }),
    ).toThrow();
  });
});

describe('triggerSendWebhook — provider routing (DR-56 per-provider webhooks)', () => {
  const realFetch = global.fetch;
  const realEnv = { gmail: process.env.N8N_WEBHOOK_URL, imap: process.env.N8N_IMAP_WEBHOOK_URL };

  beforeEach(() => {
    process.env.N8N_WEBHOOK_URL = 'http://n8n:5678/webhook/mailbox-send';
    process.env.N8N_IMAP_WEBHOOK_URL = 'http://n8n:5678/webhook/mailbox-imap-send';
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ success: true }),
    }) as unknown as typeof fetch;
  });

  afterEach(() => {
    global.fetch = realFetch;
    process.env.N8N_WEBHOOK_URL = realEnv.gmail;
    process.env.N8N_IMAP_WEBHOOK_URL = realEnv.imap;
    vi.restoreAllMocks();
  });

  it('routes gmail (the default) to N8N_WEBHOOK_URL with { draft_id }', async () => {
    const res = await triggerSendWebhook(7);
    expect(res.success).toBe(true);
    const [url, init] = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toBe('http://n8n:5678/webhook/mailbox-send');
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({ draft_id: 7 });
  });

  it('routes imap to N8N_IMAP_WEBHOOK_URL (leaves the live Gmail webhook untouched)', async () => {
    const res = await triggerSendWebhook(9, 'imap');
    expect(res.success).toBe(true);
    const [url] = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toBe('http://n8n:5678/webhook/mailbox-imap-send');
  });

  it('fails with the provider-correct env name when the imap webhook is unset', async () => {
    process.env.N8N_IMAP_WEBHOOK_URL = '';
    const res = await triggerSendWebhook(9, 'imap');
    expect(res.success).toBe(false);
    expect(res.error).toContain('N8N_IMAP_WEBHOOK_URL');
    expect(global.fetch).not.toHaveBeenCalled();
  });
});
