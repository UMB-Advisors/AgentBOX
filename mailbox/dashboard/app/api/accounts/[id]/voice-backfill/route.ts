import { type NextRequest, NextResponse } from 'next/server';
import { runGmailVoiceBackfill } from '@/lib/mail/gmail-voice-backfill';
import {
  type ImapBackfillCounts,
  runImapVoiceBackfill,
  VoiceBackfillError,
} from '@/lib/mail/imap-voice-backfill';
import { parseJson, parseParams } from '@/lib/middleware/validate';
import { OAuthTokenError } from '@/lib/oauth/google';
import { extractPersona } from '@/lib/persona/extract';
import { getAccountProviderById } from '@/lib/queries-accounts';
import { listSentHistoryForExtraction, upsertPersona } from '@/lib/queries-persona';
import { accountIdParamSchema } from '@/lib/schemas/accounts';
import { voiceBackfillSchema } from '@/lib/schemas/persona';

// MBOX-373 (V6 P2, IMAP) + MBOX-399 (V6 P3, Gmail) — historical Sent-mail voice
// backfill, then immediately learn the voice. Closes the cold-start gap: a
// freshly connected inbox has no approved-draft history, so the account-scoped
// persona refresh (POST /api/persona/refresh) returns 409. This route first
// pulls the inbox's own Sent mail into mailbox.sent_history, then runs the SAME
// extract+upsert the refresh route does — so "Learn voice" on /settings/accounts
// works day one. Dispatches by the account's transport provider:
//   • imap  → runImapVoiceBackfill (reads the Sent mailbox over IMAP)
//   • gmail → runGmailVoiceBackfill (reads Sent via the per-account gmail grant)
//   • microsoft → not yet (Graph backfill is a later slice) → 422
//
// Error mapping: setup/credential fault (not-found / wrong-provider) → 422; a
// Gmail inbox with no OAuth grant yet → 409 + code 'gmail_not_connected' (the UI
// turns that into the consent redirect); a still-empty sent_history after the
// pull → 409 (same shape as refresh). Privacy: extraction + ingest run entirely
// on-appliance — no sent-email content leaves Postgres during this call.

export const dynamic = 'force-dynamic';

export async function POST(
  request: NextRequest,
  { params }: { params: { id: string } },
): Promise<NextResponse> {
  const p = parseParams(params, accountIdParamSchema);
  if (!p.ok) return p.response;
  const { id } = p.data;

  const parsed = await parseJson(request, voiceBackfillSchema);
  if (!parsed.ok) return parsed.response;

  const provider = await getAccountProviderById(id);
  if (provider === null) {
    return NextResponse.json({ error: `account ${id} not found` }, { status: 404 });
  }
  if (provider !== 'imap' && provider !== 'gmail') {
    // Microsoft Graph Sent backfill is a later slice — keep the contract honest.
    return NextResponse.json(
      { error: `voice backfill is not supported for ${provider} inboxes yet` },
      { status: 422 },
    );
  }

  const backfillOpts = {
    lookbackHours: parsed.data.lookback_hours,
    maxMessages: parsed.data.max_messages,
  };

  try {
    const counts: ImapBackfillCounts =
      provider === 'gmail'
        ? await runGmailVoiceBackfill(id, backfillOpts)
        : await runImapVoiceBackfill(id, backfillOpts);

    // Same extract+upsert as POST /api/persona/refresh, account-scoped.
    const rows = await listSentHistoryForExtraction(undefined, id);
    if (rows.length === 0) {
      return NextResponse.json(
        {
          error:
            'No sent_history for this inbox after backfill — the Sent mailbox may be empty or unreachable',
          account_id: id,
        },
        { status: 409 },
      );
    }
    const result = extractPersona(rows);
    const persona = await upsertPersona(
      result.statistical_markers as unknown as Record<string, unknown>,
      result.category_exemplars as unknown as Record<string, unknown>,
      result.source_email_count,
      id,
    );

    return NextResponse.json({
      backfill: counts,
      persona,
      source_email_count: result.source_email_count,
    });
  } catch (error) {
    // Gmail inbox with no per-account grant (or a stale/insufficient one) — the
    // operator must run the gmail.readonly consent. 409 + a code the UI keys on
    // to launch the consent redirect (one click ends in a backfill on return).
    if (error instanceof OAuthTokenError) {
      if (error.kind === 'transient') {
        return NextResponse.json(
          { error: 'Google token endpoint unavailable — try again shortly', account_id: id },
          { status: 502 },
        );
      }
      // 'not_connected' (no grant yet) or 'auth' (revoked / missing scope) →
      // both resolved by (re)connecting the inbox's Gmail.
      return NextResponse.json(
        { error: error.message, code: 'gmail_not_connected', account_id: id },
        { status: 409 },
      );
    }
    // A misconfigured account (wrong provider / no credential) is a caller/setup
    // fault, not a server fault.
    if (error instanceof VoiceBackfillError) {
      return NextResponse.json({ error: error.message }, { status: 422 });
    }
    // Full detail goes to the server log only — a raw imapflow/Kysely message
    // can carry host:port / server-banner internals, so the client gets an
    // opaque message (mirrors the connectImap 500 path).
    console.error(`POST /api/accounts/${id}/voice-backfill failed:`, error);
    return NextResponse.json({ error: 'Internal error' }, { status: 500 });
  }
}
