// dashboard/lib/mail/imap-voice-backfill.ts
//
// MBOX-373 (MBOX-162 V6 P2) — IMAP historical Sent-mail backfill. Lets a freshly
// connected IMAP inbox learn its voice cold-start: stream its Sent mailbox via
// ImapSmtpProvider.backfillSent and upsert each message into mailbox.sent_history
// so the account-scoped persona extraction (POST /api/persona/refresh, the
// "Learn voice" button) has rows to extract from before any draft is approved.
//
// Sent-only ingest needs NO new migration — inbox_message_id / draft_id are
// nullable and `source` defaults are open; we mirror the onboarding Gmail
// ingestor's upsertReply() shape (lib/onboarding/gmail-history-backfill.ts) but
// with inbox_message_id:null (no paired inbound) and an explicit account_id.
//
// Privacy: nothing here logs email bodies — only message_ids + tallied counts.
// The decrypted app-password lives only in an ephemeral in-memory MailAccount;
// it is never persisted and never leaves this process.

import type { Kysely } from 'kysely';
import { getKysely } from '@/lib/db';
import type { DB } from '@/lib/db/schema';
import { ImapSmtpProvider } from '@/lib/mail/providers/imap';
import type { CanonicalMessage, MailAccount, MailProvider } from '@/lib/mail/providers/types';
import { decryptToken } from '@/lib/oauth/google';

// Mirror the 90-day defaults of the Gmail/RAG backfills.
const DEFAULT_LOOKBACK_HOURS = 90 * 24;
const DEFAULT_MAX_MESSAGES = 500;

export interface ImapBackfillCounts {
  messages_seen: number;
  sent_history_upserts: number;
  skipped_existing: number;
  malformed: number;
}

export interface ImapVoiceBackfillDeps {
  db?: Kysely<DB>;
  provider?: MailProvider;
}

// Setup/credential fault for a voice backfill (account not found, wrong
// provider, missing credential). Caller maps it to a 4xx — it is not a server
// fault. Shared by the IMAP (here) and Gmail (gmail-voice-backfill.ts) paths.
export class VoiceBackfillError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'VoiceBackfillError';
  }
}

// Upsert one CanonicalMessage into mailbox.sent_history as a Sent-only backfill
// row (no paired inbound, account_id-tagged), deduped on the migration-011 /
// MBOX-348 partial unique index (account_id, message_id) WHERE message_id IS NOT
// NULL. Returns which bucket the row fell into so the caller can tally counts.
// Shared by both provider orchestrators so the row shape + dedup live in ONE
// place. Privacy: a failure logs the message_id only, never body content.
export async function archiveSentMessage(
  db: Kysely<DB>,
  accountId: number,
  msg: CanonicalMessage,
): Promise<'upserted' | 'skipped_existing' | 'malformed'> {
  try {
    const r = await db
      .insertInto('sent_history')
      .values({
        account_id: accountId,
        message_id: msg.provider_message_id || null,
        draft_id: null,
        inbox_message_id: null,
        from_addr: msg.from_addr,
        to_addr: msg.to_addr,
        subject: msg.subject || null,
        body_text: null,
        thread_id: msg.thread_id,
        draft_original: null,
        draft_sent: msg.body || '',
        draft_source: 'local',
        classification_category: 'unknown',
        classification_confidence: 0,
        sent_at: msg.received_at,
        source: 'backfill',
      })
      .onConflict((oc) =>
        oc.columns(['account_id', 'message_id']).where('message_id', 'is not', null).doNothing(),
      )
      .executeTakeFirst();
    const affected = r?.numInsertedOrUpdatedRows ?? BigInt(0);
    return affected === BigInt(0) ? 'skipped_existing' : 'upserted';
  } catch (err) {
    console.error(
      `archiveSentMessage upsert failed (message_id=${msg.provider_message_id || 'none'}):`,
      err instanceof Error ? err.message : String(err),
    );
    return 'malformed';
  }
}

export async function runImapVoiceBackfill(
  accountId: number,
  opts?: { lookbackHours?: number; maxMessages?: number },
  deps?: ImapVoiceBackfillDeps,
): Promise<ImapBackfillCounts> {
  const lookbackHours = opts?.lookbackHours ?? DEFAULT_LOOKBACK_HOURS;
  const maxMessages = opts?.maxMessages ?? DEFAULT_MAX_MESSAGES;
  const db = deps?.db ?? getKysely();
  const provider = deps?.provider ?? new ImapSmtpProvider();

  const row = await db
    .selectFrom('accounts')
    .select(['id', 'provider', 'provider_config', 'provider_secret_enc'])
    .where('id', '=', accountId)
    .executeTakeFirst();
  if (!row) throw new VoiceBackfillError(`account ${accountId} not found`);
  if (row.provider !== 'imap') {
    throw new VoiceBackfillError(
      `voice backfill is IMAP-only; account ${accountId} is ${row.provider}`,
    );
  }
  if (!row.provider_secret_enc) {
    throw new VoiceBackfillError(
      `account ${accountId} has no stored credential — reconnect the inbox before learning its voice`,
    );
  }

  const password = decryptToken(row.provider_secret_enc);

  // Ephemeral account with the decrypted password injected for the transport
  // layer (ImapSmtpProvider.backfillSent reads provider_config.password).
  const account: MailAccount = {
    id: row.id,
    provider: 'imap',
    provider_config: {
      ...(row.provider_config as Record<string, unknown>),
      password,
    },
  };

  const counts: ImapBackfillCounts = {
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
