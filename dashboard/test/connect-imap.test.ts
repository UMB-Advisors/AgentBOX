// MBOX-357 (P1 T6) — connectImap orchestration shared by the onboarding route
// and the settings "Add mailbox" route. The load-bearing property: the settings
// path (advanceOnboarding:false) must NEVER call setEmail() — that would regress
// a LIVE appliance's onboarding.stage out of 'live'. Probe + persist are mocked
// so this is deterministic (no DB, no real sockets).

import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/mail/test-connection', () => ({ testMailConnection: vi.fn() }));
vi.mock('@/lib/queries-accounts', () => ({ createImapAccount: vi.fn() }));
vi.mock('@/lib/queries-onboarding', () => ({ setEmail: vi.fn() }));
vi.mock('@/lib/oauth/google', () => ({ encryptToken: vi.fn(() => 'iv.tag.ct') }));

import { connectImap } from '@/lib/mail/connect-imap';
import { testMailConnection } from '@/lib/mail/test-connection';
import { createImapAccount } from '@/lib/queries-accounts';
import { setEmail } from '@/lib/queries-onboarding';

const mockProbe = testMailConnection as unknown as ReturnType<typeof vi.fn>;
const mockCreate = createImapAccount as unknown as ReturnType<typeof vi.fn>;
const mockSetEmail = setEmail as unknown as ReturnType<typeof vi.fn>;

const body = {
  mode: 'save' as const,
  email: 'Op@Example.com',
  imap_host: 'imap.example.com',
  imap_port: 993,
  smtp_host: 'smtp.example.com',
  smtp_port: 587,
  username: 'op@example.com',
  app_password: 'app-pw',
};

afterEach(() => vi.clearAllMocks());

describe('connectImap', () => {
  it('a failed probe returns 422 and persists nothing', async () => {
    mockProbe.mockResolvedValue({
      ok: false,
      imap: { ok: false, detail: 'x' },
      smtp: { ok: true, detail: 'y' },
    });
    const res = await connectImap(body, { advanceOnboarding: false });
    expect(res.status).toBe(422);
    expect(mockCreate).not.toHaveBeenCalled();
    expect(mockSetEmail).not.toHaveBeenCalled();
  });

  it('mode:test with a passing probe returns 200 without persisting', async () => {
    mockProbe.mockResolvedValue({
      ok: true,
      imap: { ok: true, detail: 'i' },
      smtp: { ok: true, detail: 's' },
    });
    const res = await connectImap({ ...body, mode: 'test' }, { advanceOnboarding: true });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, tested: true });
    expect(mockCreate).not.toHaveBeenCalled();
    expect(mockSetEmail).not.toHaveBeenCalled();
  });

  it('settings save (advanceOnboarding:false) creates the account but NEVER calls setEmail', async () => {
    mockProbe.mockResolvedValue({
      ok: true,
      imap: { ok: true, detail: 'i' },
      smtp: { ok: true, detail: 's' },
    });
    mockCreate.mockResolvedValue({ id: 7, adopted: false });
    const res = await connectImap(body, { advanceOnboarding: false });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, account_id: 7 });
    expect(mockCreate).toHaveBeenCalledTimes(1);
    // lowercases the email before persisting
    expect(mockCreate.mock.calls[0][0]).toMatchObject({ email: 'op@example.com' });
    expect(mockSetEmail).not.toHaveBeenCalled();
  });

  it('onboarding save (advanceOnboarding:true) creates the account AND advances the stage', async () => {
    mockProbe.mockResolvedValue({
      ok: true,
      imap: { ok: true, detail: 'i' },
      smtp: { ok: true, detail: 's' },
    });
    mockCreate.mockResolvedValue({ id: 1, adopted: true });
    const res = await connectImap(body, { advanceOnboarding: true });
    expect(res.status).toBe(200);
    expect(mockCreate).toHaveBeenCalledTimes(1);
    expect(mockSetEmail).toHaveBeenCalledWith('op@example.com');
  });
});
