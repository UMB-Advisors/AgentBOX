// dashboard/lib/mail/providers/index.ts
//
// MBOX-356 (P0) — MailProvider factory. Resolves the transport implementation
// from accounts.provider. Callers branch on provider.capabilities.*, never on
// the provider name (DR-55). Closed set: an unknown provider is a programming
// error, not a runtime fallthrough.

import { GmailProvider } from './gmail';
import { ImapSmtpProvider } from './imap';
import { MicrosoftGraphProvider } from './microsoft';
import type { MailAccount, MailProvider, MailProviderKind } from './types';

export { GmailProvider, NotImplementedInP0 } from './gmail';
export { ImapSmtpProvider, NotImplementedYet } from './imap';
export { GraphNotImplementedYet, MicrosoftGraphProvider } from './microsoft';
export * from './types';

// Singleton instances — providers are stateless (config comes in per call via
// MailAccount), so one instance per kind is sufficient.
const GMAIL = new GmailProvider();
const IMAP = new ImapSmtpProvider();
const MICROSOFT = new MicrosoftGraphProvider();

export function providerFor(account: Pick<MailAccount, 'provider'>): MailProvider {
  return providerForKind(account.provider);
}

export function providerForKind(kind: MailProviderKind): MailProvider {
  switch (kind) {
    case 'gmail':
      return GMAIL;
    case 'imap':
      return IMAP;
    case 'microsoft':
      return MICROSOFT;
    default: {
      // Exhaustiveness guard — if MailProviderKind grows, this stops compiling.
      const _exhaustive: never = kind;
      throw new Error(`Unknown MailProvider kind: ${String(_exhaustive)}`);
    }
  }
}
