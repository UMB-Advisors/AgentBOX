// dashboard/lib/mail/gmail-voice-backfill.ts
//
// MBOX-399 (MBOX-162 V6 P3) — Gmail historical Sent-mail backfill, the Gmail
// twin of runImapVoiceBackfill (P2). Lets a Gmail inbox learn its voice
// cold-start by streaming its own Sent mail via the per-account gmail.readonly
// OAuth grant and upserting into mailbox.sent_history, so the account-scoped
// persona extraction has rows before any draft is approved.
//
// Why a per-account grant: the single n8n Gmail credential only covers the
// primary inbox. Account #2/#3 each need their OWN gmail.readonly token, stored
// as oauth_tokens(provider='google_gmail', account_id) — see lib/oauth/google.ts.
//
// This is the orchestration layer (DB + token resolution); the REST I/O lives in
// GmailProvider.backfillSent → gmail-fetch.ts, and the sent_history upsert/dedup
// is the SHARED archiveSentMessage (imap-voice-backfill.ts). Privacy: nothing
// here logs email bodies — only message_ids + tallied counts. The access token
// lives only in an ephemeral in-memory MailAccount; never persisted.

import type { Kysely } from 'kysely';
import { getKysely } from '@/lib/db';
import type { DB } from '@/lib/db/schema';
import {
  archiveSentMessage,
  type ImapBackfillCounts,
  VoiceBackfillError,
} from '@/lib/mail/imap-voice-backfill';
import { GmailProvider } from '@/lib/mail/providers/gmail';
import type { MailAccount, MailProvider } from '@/lib/mail/providers/types';
import { getAccessToken } from '@/lib/oauth/google';

// Mirror the 90-day defaults of the IMAP/RAG backfills.
const DEFAULT_LOOKBACK_HOURS = 90 * 24;
const DEFAULT_MAX_MESSAGES = 500;

// Same count shape as the IMAP path so the route can return either uniformly.
export type GmailBackfillCounts = ImapBackfillCounts;

export interface GmailVoiceBackfillDeps {
  db?: Kysely<DB>;
  provider?: MailProvider;
  // Injectable for tests — the real path resolves the per-account gmail grant.
  getAccessToken?: (
    provider: 'google_gmail',
    timeoutMs: number,
    accountId: number,
  ) => Promise<string>;
}

export async function runGmailVoiceBackfill(
  accountId: number,
  opts?: { lookbackHours?: number; maxMessages?: number },
  deps?: GmailVoiceBackfillDeps,
): Promise<GmailBackfillCounts> {
  const lookbackHours = opts?.lookbackHours ?? DEFAULT_LOOKBACK_HOURS;
  const maxMessages = opts?.maxMessages ?? DEFAULT_MAX_MESSAGES;
  const db = deps?.db ?? getKysely();
  const provider = deps?.provider ?? new GmailProvider();
  const resolveToken = deps?.getAccessToken ?? getAccessToken;

  const row = await db
    .selectFrom('accounts')
    .select(['id', 'provider', 'provider_config'])
    .where('id', '=', accountId)
    .executeTakeFirst();
  if (!row) throw new VoiceBackfillError(`account ${accountId} not found`);
  if (row.provider !== 'gmail') {
    throw new VoiceBackfillError(
      `gmail voice backfill is gmail-only; account ${accountId} is ${row.provider}`,
    );
  }

  // Resolve the per-account gmail.readonly access token. Throws OAuthTokenError
  // ('not_connected' when the inbox has no gmail grant yet) — the route maps
  // that to a 409 that drives the "connect Gmail" consent redirect.
  const accessToken = await resolveToken('google_gmail', 10_000, accountId);

  // Ephemeral account with the access token injected for the transport layer
  // (GmailProvider.backfillSent reads provider_config.access_token).
  const account: MailAccount = {
    id: row.id,
    provider: 'gmail',
    provider_config: {
      ...(row.provider_config as Record<string, unknown>),
      access_token: accessToken,
    },
  };

  const counts: GmailBackfillCounts = {
    messages_seen: 0,
    sent_history_upserts: 0,
    skipped_existing: 0,
    malformed: 0,
  };

  for await (const msg of provider.backfillSent(account, { lookbackHours, maxMessages })) {
    counts.messages_seen += 1;
    const bucket = await archiveSentMessage(db, accountId, msg);
    if (bucket === 'upserted') counts.sent_history_upserts += 1;
    else if (bucket === 'skipped_existing') counts.skipped_existing += 1;
    else counts.malformed += 1;
  }

  return counts;
}
