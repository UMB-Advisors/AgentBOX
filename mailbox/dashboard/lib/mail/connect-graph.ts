// dashboard/lib/mail/connect-graph.ts
//
// MBOX-358 (P2) — shared orchestration for connecting a Microsoft 365 / Graph
// mailbox, used by BOTH the onboarding wizard
// (POST /api/internal/onboarding/graph-connect) and the settings "Add mailbox"
// flow (POST /api/accounts/microsoft). Mirrors connect-imap.ts so the two
// callers can't drift: probe → 422-on-fail → (test|save) → persist.
//
// The ONLY difference between the two callers is `advanceOnboarding` — same as
// IMAP: onboarding records the mailbox + lands stage='ingesting'; a live
// appliance must NOT call setEmail (it would regress onboarding.stage out of
// 'live'). createMicrosoftAccount handles the live case (default account already
// has a real email → inserts a new non-default account).

import { testGraphConnection } from '@/lib/mail/test-graph-connection';
import { encryptToken } from '@/lib/oauth/google';
import { createMicrosoftAccount } from '@/lib/queries-accounts';
import { setEmail } from '@/lib/queries-onboarding';
import type { GraphConnectBody } from '@/lib/schemas/graph-connect';

export interface ConnectGraphResult {
  status: number;
  body: Record<string, unknown>;
}

export async function connectGraph(
  d: GraphConnectBody,
  opts: { advanceOnboarding: boolean },
): Promise<ConnectGraphResult> {
  const email = d.email.toLowerCase();
  // Mailbox defaults to the connecting email when not separately specified.
  const mailbox = (d.mailbox ?? d.email).toLowerCase();

  const probe = await testGraphConnection({
    tenantId: d.tenant_id,
    clientId: d.client_id,
    clientSecret: d.client_secret,
    mailbox,
  });

  if (!probe.ok) {
    // Probe failed — never persist unvalidated credentials.
    return { status: 422, body: { ok: false, token: probe.token, mailbox: probe.mailbox } };
  }

  if (d.mode === 'test') {
    return {
      status: 200,
      body: { ok: true, tested: true, token: probe.token, mailbox: probe.mailbox },
    };
  }

  // mode === 'save' — probe passed; persist with the client secret encrypted.
  try {
    const providerConfig = {
      tenant_id: d.tenant_id,
      client_id: d.client_id,
      mailbox,
      auth: 'client_credentials' as const,
    };
    const { id, adopted } = await createMicrosoftAccount({
      email,
      display_label: d.display_label ?? null,
      provider_config: providerConfig,
      secret_enc: encryptToken(d.client_secret),
    });
    if (opts.advanceOnboarding) {
      await setEmail(email);
    }
    return { status: 200, body: { ok: true, account_id: id, adopted } };
  } catch (error) {
    console.error('connectGraph (save) failed:', error);
    return {
      status: 500,
      body: { ok: false, error: error instanceof Error ? error.message : 'Internal error' },
    };
  }
}
