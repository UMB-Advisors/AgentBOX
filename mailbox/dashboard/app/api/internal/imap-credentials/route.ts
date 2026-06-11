// dashboard/app/api/internal/imap-credentials/route.ts
//
// MBOX-482 P1 — IMAP/SMTP credential materialization for the n8n credential-sync
// (Model A, addendum-01 §2: native IMAP/SMTP nodes can't take token-as-data on
// n8n 2.14.2, so each account gets a synced per-account n8n credential).
//
// This route is the ONLY place the IMAP/SMTP app-password is decrypted for the
// sync: it reads accounts.provider_config (host/port/user) + provider_secret_enc
// (the AES-256-GCM app-password) for one account and returns two n8n credential
// payloads — an `imap` and an `smtp` credential — ready for `n8n
// import:credentials`. The deploy-side executable (bin/mbox-imap-cred-sync.sh)
// fetches this, writes the cred JSON to a temp file, and shells
// `docker exec n8n import:credentials`. The decrypt key (MAILBOX_OAUTH_TOKEN_KEY)
// never leaves the dashboard; the plaintext password only crosses the docker
// network to the box tooling, which never persists it (temp file, deleted).
//
// Credential IDs are DETERMINISTIC from account_id (addendum §5: name/id n8n
// creds by account_id so re-installs / OTAs overwrite rather than orphan):
//   imap cred id = `mbximap${account_id}`   name = `MailBox IMAP <email>`
//   smtp cred id = `mbxsmtp${account_id}`   name = `MailBox SMTP <email>`
// The per-account MailBOX-Imap* clones (bin/mbox-imap-clone.sh) bind these ids.
//
// Auth: the same fail-closed X-Hermes-Internal-Token gate as the minters.
//
// Contract:
//   GET ?account_email=<email>
//     → 200 {
//         account_id, imap_cred_id, smtp_cred_id,
//         credentials: [ <n8n imap cred>, <n8n smtp cred> ]   # import:credentials shape
//       }
//     → 401 bad/missing token (or env unset)
//     → 400 malformed account_email
//     → 404 not a connected IMAP account
//     → 500 decrypt / config error

import { timingSafeEqual } from 'node:crypto';
import { type NextRequest, NextResponse } from 'next/server';
import { getPool } from '@/lib/db';
import { decryptToken } from '@/lib/oauth/google';
import { resolveIngestAccountId } from '@/lib/queries-accounts';

export const dynamic = 'force-dynamic';

const EMAIL_RE = /^[^@\s/]+@[^@\s/]+\.[^@\s/]+$/;

function authorized(req: NextRequest): boolean {
  const expected = process.env.HERMES_INTERNAL_TOKEN;
  if (!expected) return false;
  const presented = req.headers.get('x-hermes-internal-token') ?? '';
  const a = Buffer.from(presented);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

interface ImapConfig {
  imap_host?: string;
  imap_port?: number;
  smtp_host?: string;
  smtp_port?: number;
  username?: string;
}

// Deterministic n8n credential ids keyed by account_id (addendum §5). n8n cred
// ids are free-form strings; a stable per-account id means import:credentials
// OVERWRITES on re-sync / OTA rather than creating an orphan.
function imapCredId(accountId: number): string {
  return `mbximap${accountId}`;
}
function smtpCredId(accountId: number): string {
  return `mbxsmtp${accountId}`;
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  if (!authorized(req)) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  const raw = req.nextUrl.searchParams.get('account_email');
  const email = raw?.trim().toLowerCase() ?? '';
  if (!email || !EMAIL_RE.test(email)) {
    return NextResponse.json({ error: 'account_email missing or malformed' }, { status: 400 });
  }

  const resolved = await resolveIngestAccountId({ account_email: email });
  if (!resolved.ok) {
    return NextResponse.json({ error: resolved.reason }, { status: 404 });
  }

  const pool = getPool();
  const r = await pool.query<{
    provider: string;
    email_address: string;
    provider_config: ImapConfig | null;
    provider_secret_enc: string | null;
  }>(
    `SELECT provider, email_address, provider_config, provider_secret_enc
       FROM mailbox.accounts WHERE id = $1`,
    [resolved.account_id],
  );
  const row = r.rows[0];
  if (!row || row.provider !== 'imap' || !row.provider_secret_enc) {
    return NextResponse.json({ error: 'account is not a connected IMAP account' }, { status: 404 });
  }
  const cfg = row.provider_config ?? {};
  if (!cfg.imap_host || !cfg.smtp_host || !cfg.username) {
    return NextResponse.json({ error: 'account provider_config incomplete' }, { status: 500 });
  }

  let password: string;
  try {
    password = decryptToken(row.provider_secret_enc);
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'app-password decrypt failed' },
      { status: 500 },
    );
  }

  const accountId = resolved.account_id;
  const imap_cred_id = imapCredId(accountId);
  const smtp_cred_id = smtpCredId(accountId);

  // n8n `import:credentials` consumes an array of credential objects with
  // { id, name, type, data }. `imap` matches emailReadImap's credential type;
  // `smtp` matches emailSend's. Field names mirror n8n's credential schemas.
  const credentials = [
    {
      id: imap_cred_id,
      name: `MailBox IMAP ${row.email_address}`,
      type: 'imap',
      data: {
        host: cfg.imap_host,
        port: cfg.imap_port ?? 993,
        user: cfg.username,
        password,
        secure: true,
      },
    },
    {
      id: smtp_cred_id,
      name: `MailBox SMTP ${row.email_address}`,
      type: 'smtp',
      data: {
        host: cfg.smtp_host,
        port: cfg.smtp_port ?? 587,
        user: cfg.username,
        password,
        secure: (cfg.smtp_port ?? 587) === 465,
      },
    },
  ];

  return NextResponse.json({
    account_id: accountId,
    imap_cred_id,
    smtp_cred_id,
    credentials,
  });
}
