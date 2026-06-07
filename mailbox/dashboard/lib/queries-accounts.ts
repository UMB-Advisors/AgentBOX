import { sql } from 'kysely';
import { getKysely } from '@/lib/db';
import type { MailProviderKind } from '@/lib/types';

// MBOX-348 (MBOX-162 V1) — account resolution for multi-account ingestion.
//
// Every account-scoped table carries `account_id` (migration 033) with a column
// DEFAULT pointing at the seeded default account, so a writer that omits it
// still lands in the default inbox (the single-account path, un-changed). The
// ingestion fan-out instead passes the target account explicitly — by stable
// `account_email` (portable across appliances; ids differ per box) or by
// `account_id` — and these helpers turn that into the concrete id.

export interface AccountRow {
  id: number;
  email_address: string;
  display_label: string | null;
  is_default: boolean;
}

export async function listAccounts(): Promise<AccountRow[]> {
  const db = getKysely();
  return db
    .selectFrom('accounts')
    .select(['id', 'email_address', 'display_label', 'is_default'])
    .orderBy('id')
    .execute();
}

// The backfill target / single-operator default. Post-migration there is always
// exactly one row with is_default = true (enforced by the accounts_one_default
// partial unique index).
export async function getDefaultAccountId(): Promise<number> {
  const db = getKysely();
  const row = await db
    .selectFrom('accounts')
    .select('id')
    .where('is_default', '=', true)
    .executeTakeFirst();
  if (!row) throw new Error('no default account — migration 033 seed missing');
  return row.id;
}

// MBOX-399 — the transport provider for one account, or null if it doesn't
// exist. The voice-backfill route reads this to dispatch by provider
// (imap→runImapVoiceBackfill, gmail→runGmailVoiceBackfill) before hitting the
// provider-specific orchestrator.
export async function getAccountProviderById(id: number): Promise<MailProviderKind | null> {
  const db = getKysely();
  const row = await db
    .selectFrom('accounts')
    .select('provider')
    .where('id', '=', id)
    .executeTakeFirst();
  return row ? (row.provider as MailProviderKind) : null;
}

export type ResolveAccountResult = { ok: true; account_id: number } | { ok: false; reason: string };

// Resolution order: explicit account_id wins; else resolve a stable
// account_email (case-insensitive — accounts.email_address is stored as the
// operator typed it); else fall back to the default account (the legacy
// single-account ingest path that sends neither). An account_email that does
// not match a connected account is a fan-out misconfiguration and is rejected
// rather than silently dumped into the default inbox — landing one identity's
// mail under another's voice/history is the exact failure multi-account exists
// to prevent.
export async function resolveIngestAccountId(input: {
  account_id?: number;
  account_email?: string;
}): Promise<ResolveAccountResult> {
  const db = getKysely();

  if (input.account_id !== undefined) {
    const row = await db
      .selectFrom('accounts')
      .select('id')
      .where('id', '=', input.account_id)
      .executeTakeFirst();
    if (!row) return { ok: false, reason: `unknown account_id ${input.account_id}` };
    return { ok: true, account_id: row.id };
  }

  if (input.account_email) {
    const email = input.account_email.trim().toLowerCase();
    const row = await db
      .selectFrom('accounts')
      .select('id')
      .where(sql<boolean>`lower(email_address) = ${email}`)
      .executeTakeFirst();
    if (!row) return { ok: false, reason: `unknown account_email ${input.account_email}` };
    return { ok: true, account_id: row.id };
  }

  return { ok: true, account_id: await getDefaultAccountId() };
}

// MBOX-357 (P1 T5) — resolve a draft's owning account + mail-transport provider
// so the send path can (a) gate on the right per-(account, provider) cooldown
// and (b) route to the right n8n send webhook (gmail → mailbox-send; imap →
// mailbox-imap-send). Returns null when the draft id doesn't exist — the caller
// proceeds with the default Gmail behavior and the status-flip step surfaces the
// not-found 409, so no extra error branch is needed here.
export interface DraftProviderContext {
  account_id: number;
  provider: MailProviderKind;
}

// MBOX-357 (P1 T6) — the migration-033 seed sentinel for an un-onboarded
// appliance's default account. While the default account still carries this
// placeholder, the IMAP connect ADOPTS it (claims the default) so the new IMAP
// account becomes the one every account_id-defaulted pipeline row resolves to.
const SENTINEL_DEFAULT_EMAIL = 'primary@appliance.local';

export interface CreateImapAccountInput {
  email: string;
  display_label: string | null;
  // Non-secret connection params persisted to accounts.provider_config.
  provider_config: Record<string, unknown>;
  // AES-256-GCM-encrypted app-password (lib/oauth/google.ts:encryptToken).
  secret_enc: string;
}

// Create (or adopt) the IMAP account. On a fresh appliance the migration-033
// default account is still the 'primary@appliance.local' sentinel — we claim it
// in place (stays is_default) so ingest/queue/persona resolve to it. Once a real
// account exists, a second IMAP account is inserted non-default (multi-account).
export async function createImapAccount(
  input: CreateImapAccountInput,
): Promise<{ id: number; adopted: boolean }> {
  const db = getKysely();
  // jsonb write idiom used across the codebase (queries-persona, draft-prompt):
  // bind JSON text + cast ::jsonb inline in the set/values clause.
  const cfgJson = JSON.stringify(input.provider_config);

  const def = await db
    .selectFrom('accounts')
    .select(['id', 'email_address'])
    .where('is_default', '=', true)
    .executeTakeFirst();

  if (def && def.email_address === SENTINEL_DEFAULT_EMAIL) {
    const row = await db
      .updateTable('accounts')
      .set({
        email_address: input.email,
        display_label: input.display_label,
        provider: 'imap',
        provider_config: sql`${cfgJson}::jsonb`,
        provider_secret_enc: input.secret_enc,
      })
      .where('id', '=', def.id)
      .returning('id')
      .executeTakeFirstOrThrow();
    return { id: row.id, adopted: true };
  }

  const row = await db
    .insertInto('accounts')
    .values({
      email_address: input.email,
      display_label: input.display_label,
      is_default: false,
      provider: 'imap',
      provider_config: sql`${cfgJson}::jsonb`,
      provider_secret_enc: input.secret_enc,
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  return { id: row.id, adopted: false };
}

// MBOX-358 (P2) — Microsoft 365 / Graph account create-or-adopt. Structurally
// identical to createImapAccount (same fresh-appliance sentinel-adoption rule),
// differing only in provider='microsoft'. provider_config holds the non-secret
// BYO Azure app-reg params {tenant_id, client_id, mailbox, auth}; secret_enc is
// the AES-256-GCM-encrypted client secret (migration 040, the column IMAP's
// app-password also uses).
export interface CreateMicrosoftAccountInput {
  email: string;
  display_label: string | null;
  provider_config: Record<string, unknown>;
  secret_enc: string;
}

export async function createMicrosoftAccount(
  input: CreateMicrosoftAccountInput,
): Promise<{ id: number; adopted: boolean }> {
  const db = getKysely();
  const cfgJson = JSON.stringify(input.provider_config);

  const def = await db
    .selectFrom('accounts')
    .select(['id', 'email_address'])
    .where('is_default', '=', true)
    .executeTakeFirst();

  if (def && def.email_address === SENTINEL_DEFAULT_EMAIL) {
    const row = await db
      .updateTable('accounts')
      .set({
        email_address: input.email,
        display_label: input.display_label,
        provider: 'microsoft',
        provider_config: sql`${cfgJson}::jsonb`,
        provider_secret_enc: input.secret_enc,
      })
      .where('id', '=', def.id)
      .returning('id')
      .executeTakeFirstOrThrow();
    return { id: row.id, adopted: true };
  }

  const row = await db
    .insertInto('accounts')
    .values({
      email_address: input.email,
      display_label: input.display_label,
      is_default: false,
      provider: 'microsoft',
      provider_config: sql`${cfgJson}::jsonb`,
      provider_secret_enc: input.secret_enc,
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  return { id: row.id, adopted: false };
}

export async function getDraftProviderContext(
  draftId: number,
): Promise<DraftProviderContext | null> {
  const db = getKysely();
  const row = await db
    .selectFrom('drafts as d')
    .innerJoin('accounts as a', 'a.id', 'd.account_id')
    .select(['d.account_id as account_id', 'a.provider as provider'])
    .where('d.id', '=', draftId)
    .executeTakeFirst();
  if (!row) return null;
  return { account_id: row.account_id, provider: row.provider as MailProviderKind };
}

// ──────────────────────────────────────────────────────────────────────────
// MBOX-366 (MBOX-162 V5) — account registry CRUD for /settings/accounts.
//
// V1–V3 made `account_id` a first-class dimension but left no way to create
// account #2 short of a raw `psql INSERT`. These helpers back the operator UI.
// No migration — the `accounts` table (033) + `provider`/`provider_config`
// (037) already exist. Per the honest bound on the V5 issue: creating a row
// here lights up the V3 selector/badge + V2 per-account persona/RAG scoping;
// it does NOT wire the account's Gmail OAuth / n8n ingestion (operator work,
// tracked under multi-provider MBOX-355/356).
// ──────────────────────────────────────────────────────────────────────────

// Richer view than AccountRow (which the V3 selector keeps lean). Includes the
// transport provider + created_at for the management list.
export interface AccountDetail {
  id: number;
  email_address: string;
  display_label: string | null;
  is_default: boolean;
  provider: MailProviderKind;
  created_at: string;
}

const ACCOUNT_DETAIL_COLUMNS = [
  'id',
  'email_address',
  'display_label',
  'is_default',
  'provider',
  'created_at',
] as const;

export type AccountMutationErrorCode =
  | 'duplicate_email'
  | 'not_found'
  | 'cannot_delete_default'
  | 'account_has_data';

// Typed failures the route layer maps to specific HTTP codes (409/404) instead
// of a blanket 500. Anything else (a real DB fault) propagates as a raw Error.
export class AccountMutationError extends Error {
  constructor(
    public readonly code: AccountMutationErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'AccountMutationError';
  }
}

// pg unique-violation. The accounts.email_address UNIQUE constraint (033) is
// the only one that can fire on insert here.
function isUniqueViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: string }).code === '23505';
}

export async function listAccountsDetailed(): Promise<AccountDetail[]> {
  const db = getKysely();
  const rows = await db
    .selectFrom('accounts')
    .select(ACCOUNT_DETAIL_COLUMNS)
    .orderBy('is_default', 'desc')
    .orderBy('id')
    .execute();
  return rows as AccountDetail[];
}

export async function createAccount(input: {
  email_address: string;
  display_label: string | null;
  provider: MailProviderKind;
  provider_config?: Record<string, unknown>;
}): Promise<AccountDetail> {
  const db = getKysely();
  try {
    const row = await db
      .insertInto('accounts')
      .values({
        email_address: input.email_address,
        display_label: input.display_label,
        provider: input.provider,
        // jsonb write convention: ${JSON.stringify(obj)}::jsonb (mirrors
        // queries-persona / queries-kb). is_default + created_at use DB
        // defaults — a new account is never the default (set-default is an
        // explicit, separate action so the swap is intentional).
        provider_config: sql`${JSON.stringify(input.provider_config ?? {})}::jsonb`,
      })
      .returning(ACCOUNT_DETAIL_COLUMNS)
      .executeTakeFirstOrThrow();
    return row as AccountDetail;
  } catch (err) {
    if (isUniqueViolation(err)) {
      throw new AccountMutationError(
        'duplicate_email',
        `an inbox with address ${input.email_address} is already connected`,
      );
    }
    throw err;
  }
}

// Edit label / provider in place. email_address is immutable — it's the stable
// fan-out key (resolveIngestAccountId) and the RAG point-UUID salt; renaming it
// would orphan a connected inbox's history. Returns null when the id is gone.
export async function updateAccount(
  id: number,
  patch: { display_label?: string | null; provider?: MailProviderKind },
): Promise<AccountDetail | null> {
  const db = getKysely();
  const set: Record<string, unknown> = {};
  if (patch.display_label !== undefined) set.display_label = patch.display_label;
  if (patch.provider !== undefined) set.provider = patch.provider;
  if (Object.keys(set).length === 0) {
    // Nothing to change — return the current row so the caller still gets state.
    const row = await db
      .selectFrom('accounts')
      .select(ACCOUNT_DETAIL_COLUMNS)
      .where('id', '=', id)
      .executeTakeFirst();
    return (row as AccountDetail) ?? null;
  }
  const row = await db
    .updateTable('accounts')
    .set(set)
    .where('id', '=', id)
    .returning(ACCOUNT_DETAIL_COLUMNS)
    .executeTakeFirst();
  return (row as AccountDetail) ?? null;
}

// Re-point the default inbox. The partial unique index `accounts_one_default`
// (033) permits at most one is_default=true row, so this MUST clear the old
// default before setting the new one — done in a single transaction so a
// concurrent reader never sees zero (or two) defaults. Throws not_found when
// the target id doesn't exist.
export async function setDefaultAccount(id: number): Promise<AccountDetail> {
  const db = getKysely();
  return db.transaction().execute(async (trx) => {
    const target = await trx
      .selectFrom('accounts')
      .select('id')
      .where('id', '=', id)
      .executeTakeFirst();
    if (!target) {
      throw new AccountMutationError('not_found', `no account with id ${id}`);
    }
    // Clear first (satisfies the partial unique index), then set the new one.
    await trx
      .updateTable('accounts')
      .set({ is_default: false })
      .where('is_default', '=', true)
      .execute();
    const row = await trx
      .updateTable('accounts')
      .set({ is_default: true })
      .where('id', '=', id)
      .returning(ACCOUNT_DETAIL_COLUMNS)
      .executeTakeFirstOrThrow();
    return row as AccountDetail;
  });
}

// True when any account-scoped row references this account. Guards delete: a
// connected inbox with mail/draft history must not be dropped (it would orphan
// inbox_messages / drafts / sent_history rows whose account_id FK points here).
export async function accountHasData(id: number): Promise<boolean> {
  const db = getKysely();
  const row = await db
    .selectNoFrom((eb) => [
      eb
        .exists(eb.selectFrom('inbox_messages').select('id').where('account_id', '=', id).limit(1))
        .as('has_inbox'),
      eb
        .exists(eb.selectFrom('drafts').select('id').where('account_id', '=', id).limit(1))
        .as('has_drafts'),
      eb
        .exists(eb.selectFrom('sent_history').select('id').where('account_id', '=', id).limit(1))
        .as('has_sent'),
    ])
    .executeTakeFirst();
  return Boolean(row?.has_inbox || row?.has_drafts || row?.has_sent);
}

// Delete a connected inbox. Refuses the default (would leave the appliance with
// no default → breaks getDefaultAccountId and every column DEFAULT) and refuses
// any account that already has mail/draft history. Returns true on delete,
// throws AccountMutationError for the guarded cases, false when the id is gone.
export async function deleteAccount(id: number): Promise<boolean> {
  const db = getKysely();
  const acct = await db
    .selectFrom('accounts')
    .select(['id', 'is_default'])
    .where('id', '=', id)
    .executeTakeFirst();
  if (!acct) return false;
  if (acct.is_default) {
    throw new AccountMutationError(
      'cannot_delete_default',
      'cannot delete the default inbox — set another inbox as default first',
    );
  }
  if (await accountHasData(id)) {
    throw new AccountMutationError(
      'account_has_data',
      'this inbox has mail or draft history and cannot be deleted',
    );
  }
  const res = await db.deleteFrom('accounts').where('id', '=', id).executeTakeFirst();
  return Number(res.numDeletedRows ?? 0) > 0;
}
