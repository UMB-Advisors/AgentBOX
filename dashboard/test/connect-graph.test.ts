// MBOX-358 (P2) — connectGraph orchestration (shared by onboarding + settings)
// and the pure Graph probe classifiers.
//
// connectGraph mirrors connectImap's load-bearing property: the settings path
// (advanceOnboarding:false) must NEVER call setEmail() — that would regress a
// LIVE appliance's onboarding.stage out of 'live'. Probe + persist are mocked so
// this is deterministic (no real network, no DB). The classifier suite tests the
// pure response→verdict mapping that the on-box fetch plumbing relies on.

import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/mail/test-graph-connection', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/mail/test-graph-connection')>();
  return { ...actual, testGraphConnection: vi.fn() };
});
vi.mock('@/lib/queries-accounts', () => ({ createMicrosoftAccount: vi.fn() }));
vi.mock('@/lib/queries-onboarding', () => ({ setEmail: vi.fn() }));
vi.mock('@/lib/oauth/google', () => ({ encryptToken: vi.fn(() => 'iv.tag.ct') }));

import { connectGraph } from '@/lib/mail/connect-graph';
import {
  graphMailboxVerdict,
  graphTokenVerdict,
  testGraphConnection,
} from '@/lib/mail/test-graph-connection';
import { createMicrosoftAccount } from '@/lib/queries-accounts';
import { setEmail } from '@/lib/queries-onboarding';

const mockProbe = testGraphConnection as unknown as ReturnType<typeof vi.fn>;
const mockCreate = createMicrosoftAccount as unknown as ReturnType<typeof vi.fn>;
const mockSetEmail = setEmail as unknown as ReturnType<typeof vi.fn>;

const body = {
  mode: 'save' as const,
  email: 'Op@Example.com',
  tenant_id: 'tenant-guid',
  client_id: 'client-guid',
  client_secret: 'super-secret',
};

afterEach(() => vi.clearAllMocks());

describe('connectGraph', () => {
  it('a failed probe returns 422 and persists nothing', async () => {
    mockProbe.mockResolvedValue({
      ok: false,
      token: { ok: true, detail: 't' },
      mailbox: { ok: false, detail: '403' },
    });
    const res = await connectGraph(body, { advanceOnboarding: false });
    expect(res.status).toBe(422);
    expect(mockCreate).not.toHaveBeenCalled();
    expect(mockSetEmail).not.toHaveBeenCalled();
  });

  it('mode:test with a passing probe returns 200 without persisting', async () => {
    mockProbe.mockResolvedValue({
      ok: true,
      token: { ok: true, detail: 't' },
      mailbox: { ok: true, detail: 'm' },
    });
    const res = await connectGraph({ ...body, mode: 'test' }, { advanceOnboarding: true });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, tested: true });
    expect(mockCreate).not.toHaveBeenCalled();
    expect(mockSetEmail).not.toHaveBeenCalled();
  });

  it('settings save (advanceOnboarding:false) creates the account but NEVER calls setEmail', async () => {
    mockProbe.mockResolvedValue({
      ok: true,
      token: { ok: true, detail: 't' },
      mailbox: { ok: true, detail: 'm' },
    });
    mockCreate.mockResolvedValue({ id: 9, adopted: false });
    const res = await connectGraph(body, { advanceOnboarding: false });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, account_id: 9 });
    expect(mockCreate).toHaveBeenCalledTimes(1);
    // lowercases the email + defaults the mailbox to it; secret stored encrypted.
    expect(mockCreate.mock.calls[0][0]).toMatchObject({
      email: 'op@example.com',
      provider_config: {
        tenant_id: 'tenant-guid',
        client_id: 'client-guid',
        mailbox: 'op@example.com',
      },
      secret_enc: 'iv.tag.ct',
    });
    expect(mockSetEmail).not.toHaveBeenCalled();
  });

  it('onboarding save (advanceOnboarding:true) creates the account AND advances the stage', async () => {
    mockProbe.mockResolvedValue({
      ok: true,
      token: { ok: true, detail: 't' },
      mailbox: { ok: true, detail: 'm' },
    });
    mockCreate.mockResolvedValue({ id: 1, adopted: true });
    const res = await connectGraph(body, { advanceOnboarding: true });
    expect(res.status).toBe(200);
    expect(mockCreate).toHaveBeenCalledTimes(1);
    expect(mockSetEmail).toHaveBeenCalledWith('op@example.com');
  });

  it('honors an explicit mailbox UPN distinct from the connecting email', async () => {
    mockProbe.mockResolvedValue({
      ok: true,
      token: { ok: true, detail: 't' },
      mailbox: { ok: true, detail: 'm' },
    });
    mockCreate.mockResolvedValue({ id: 2, adopted: false });
    await connectGraph({ ...body, mailbox: 'Shared@Example.com' }, { advanceOnboarding: false });
    expect(mockProbe.mock.calls[0][0]).toMatchObject({ mailbox: 'shared@example.com' });
    expect(mockCreate.mock.calls[0][0].provider_config).toMatchObject({
      mailbox: 'shared@example.com',
    });
  });
});

describe('graphTokenVerdict', () => {
  it('accepts a 200 with an access_token', () => {
    expect(graphTokenVerdict(200, { access_token: 'ey...' }).ok).toBe(true);
  });
  it('maps invalid_client to a bad-secret message', () => {
    const v = graphTokenVerdict(401, {
      error: 'invalid_client',
      error_description: 'AADSTS7000215: Invalid client secret provided.',
    });
    expect(v.ok).toBe(false);
    expect(v.detail).toContain('AADSTS7000215');
  });
  it('maps unauthorized_client / invalid_request to an app-registration problem', () => {
    expect(graphTokenVerdict(400, { error: 'unauthorized_client' }).detail).toMatch(
      /app registration/i,
    );
    expect(graphTokenVerdict(400, { error: 'invalid_request' }).ok).toBe(false);
  });
  it('a 200 with no token is still a failure', () => {
    expect(graphTokenVerdict(200, {}).ok).toBe(false);
  });
});

describe('graphMailboxVerdict', () => {
  it('200 is success', () => {
    expect(graphMailboxVerdict(200, { value: [] }).ok).toBe(true);
  });
  it('403 points at the Mail.ReadWrite app permission + admin consent', () => {
    const v = graphMailboxVerdict(403, { error: { code: 'ErrorAccessDenied' } });
    expect(v.ok).toBe(false);
    expect(v.detail).toMatch(/Mail\.ReadWrite|admin consent/i);
  });
  it('404 / ErrorInvalidUser means the mailbox UPN is wrong', () => {
    expect(graphMailboxVerdict(404, {}).detail).toMatch(/not found/i);
    expect(graphMailboxVerdict(400, { error: { code: 'ErrorInvalidUser' } }).detail).toMatch(
      /not found/i,
    );
  });
  it('401 flags a token problem', () => {
    expect(graphMailboxVerdict(401, {}).detail).toContain('401');
  });
});
