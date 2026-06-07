// dashboard/lib/mail/connect-imap.ts
//
// MBOX-357 — shared orchestration for connecting an IMAP/SMTP mailbox, used by
// BOTH the onboarding wizard (POST /api/internal/onboarding/imap-connect) and
// the settings "Add mailbox" flow (POST /api/accounts/imap). Single place for
// the probe → 422-on-fail → (test|save) → persist sequence so the two callers
// can't drift.
//
// The ONLY difference between the two callers is `advanceOnboarding`:
//   onboarding → true  (setEmail() records the mailbox + lands stage='ingesting')
//   settings   → false (a LIVE appliance must NOT call setEmail — it would
//                       REGRESS onboarding.stage out of 'live'). createImapAccount
//                       already handles the live case correctly: the default
//                       account has a real email (not the migration-033 sentinel),
//                       so it inserts a NEW non-default account.

import { testMailConnection } from '@/lib/mail/test-connection';
import { encryptToken } from '@/lib/oauth/google';
import { createImapAccount } from '@/lib/queries-accounts';
import { setEmail } from '@/lib/queries-onboarding';
import type { ImapConnectBody } from '@/lib/schemas/imap-connect';

export interface ConnectImapResult {
  status: number;
  body: Record<string, unknown>;
}

export async function connectImap(
  d: ImapConnectBody,
  opts: { advanceOnboarding: boolean },
): Promise<ConnectImapResult> {
  const email = d.email.toLowerCase();

  const probe = await testMailConnection({
    imapHost: d.imap_host,
    imapPort: d.imap_port,
    smtpHost: d.smtp_host,
    smtpPort: d.smtp_port,
    username: d.username,
    password: d.app_password,
  });

  if (!probe.ok) {
    // Probe failed — never persist unvalidated credentials.
    return { status: 422, body: { ok: false, imap: probe.imap, smtp: probe.smtp } };
  }

  if (d.mode === 'test') {
    return { status: 200, body: { ok: true, tested: true, imap: probe.imap, smtp: probe.smtp } };
  }

  // mode === 'save' — probe passed; persist encrypted.
  try {
    const providerConfig = {
      imap_host: d.imap_host,
      imap_port: d.imap_port,
      smtp_host: d.smtp_host,
      smtp_port: d.smtp_port,
      username: d.username,
      tls: true,
    };
    const { id, adopted } = await createImapAccount({
      email,
      display_label: d.display_label ?? null,
      provider_config: providerConfig,
      secret_enc: encryptToken(d.app_password),
    });
    if (opts.advanceOnboarding) {
      // Onboarding only: record the mailbox + land stage at 'ingesting'.
      await setEmail(email);
    }
    return { status: 200, body: { ok: true, account_id: id, adopted } };
  } catch (error) {
    console.error('connectImap (save) failed:', error);
    return {
      status: 500,
      body: { ok: false, error: error instanceof Error ? error.message : 'Internal error' },
    };
  }
}
