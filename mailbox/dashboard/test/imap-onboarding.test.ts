// MBOX-357 (P1 T6) — onboarding IMAP connect: schema defaults + the route's
// safety contract. The persist path (mode:save + passing probe) writes to the
// accounts table and is exercised on-box (it adopts the default account, which
// would mutate shared fixture state in a DB test); the SAFETY-critical property
// — a failed probe NEVER persists credentials — is tested here deterministically
// by mocking the probe (no DB, no real sockets).

import { afterEach, describe, expect, it, vi } from 'vitest';
import { fakeRequest } from './helpers/db';

vi.mock('@/lib/mail/test-connection', () => ({
  testMailConnection: vi.fn(),
}));

import { testMailConnection } from '@/lib/mail/test-connection';
import { imapConnectBodySchema } from '@/lib/schemas/imap-connect';

const mockProbe = testMailConnection as unknown as ReturnType<typeof vi.fn>;

describe('imapConnectBodySchema', () => {
  const base = {
    email: 'op@example.com',
    imap_host: 'imap.example.com',
    smtp_host: 'smtp.example.com',
    username: 'op@example.com',
    app_password: 'app-pw-1234',
  };

  it('defaults mode=test and the standard IMAP/SMTP ports', () => {
    const p = imapConnectBodySchema.parse(base);
    expect(p.mode).toBe('test');
    expect(p.imap_port).toBe(993);
    expect(p.smtp_port).toBe(587);
  });

  it('coerces string ports (form sends strings) and rejects a bad email', () => {
    const p = imapConnectBodySchema.parse({ ...base, imap_port: '143', smtp_port: '465' });
    expect(p.imap_port).toBe(143);
    expect(p.smtp_port).toBe(465);
    expect(() => imapConnectBodySchema.parse({ ...base, email: 'not-an-email' })).toThrow();
  });
});

describe('POST /api/internal/onboarding/imap-connect', () => {
  afterEach(() => vi.clearAllMocks());

  const body = {
    email: 'op@example.com',
    imap_host: 'imap.example.com',
    smtp_host: 'smtp.example.com',
    username: 'op@example.com',
    app_password: 'app-pw-1234',
  };

  it('mode:test with a passing probe returns 200 without persisting', async () => {
    mockProbe.mockResolvedValue({
      ok: true,
      imap: { ok: true, detail: 'IMAP login OK' },
      smtp: { ok: true, detail: 'SMTP login OK' },
    });
    const { POST } = await import('@/app/api/internal/onboarding/imap-connect/route');
    const res = await POST(fakeRequest({ body: { ...body, mode: 'test' } }));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json).toMatchObject({ ok: true, tested: true });
    // account_id is only present on a save — a test must not persist.
    expect(json.account_id).toBeUndefined();
  });

  it('mode:save with a FAILING probe returns 422 and never persists', async () => {
    mockProbe.mockResolvedValue({
      ok: false,
      imap: { ok: false, detail: 'IMAP login rejected' },
      smtp: { ok: true, detail: 'SMTP login OK' },
    });
    const { POST } = await import('@/app/api/internal/onboarding/imap-connect/route');
    const res = await POST(fakeRequest({ body: { ...body, mode: 'save' } }));
    expect(res.status).toBe(422);
    const json = await res.json();
    expect(json.ok).toBe(false);
    expect(json.account_id).toBeUndefined();
  });

  it('rejects a malformed body with 400 before probing', async () => {
    const { POST } = await import('@/app/api/internal/onboarding/imap-connect/route');
    const res = await POST(fakeRequest({ body: { email: 'op@example.com' } }));
    expect(res.status).toBe(400);
    expect(mockProbe).not.toHaveBeenCalled();
  });
});
