import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CATEGORIES } from '../lib/classification/prompt';
import { PREFERENCE_KEY_RE } from '../lib/schemas/preferences';
import {
  AUTO_SEND_ACTIONS,
  CHAT_MESSAGE_ROLES,
  KB_DOC_STATUSES,
  MAIL_PROVIDERS,
  PROMPT_RULE_SCOPES,
  REJECT_REASON_CODES,
  VIP_SENDER_KINDS,
} from '../lib/types';

// Highest-leverage test for STAQPRO-133. Asserts that the live Postgres
// CHECK constraints match (or are compatible with) the TS-side constants.
// Catches drift between code and DB enums — the kind of drift that bit
// the 2026-05-01 docs sync (status state machine + draft_source values).
//
// Requires a Postgres reachable via TEST_POSTGRES_URL or POSTGRES_URL.
// Locally: SSH-tunnel to Bob with `ssh -L 5432:localhost:5432 mailbox1 -N`,
// then `TEST_POSTGRES_URL=postgresql://mailbox:<pw>@localhost:5432/mailbox npm test`.
// In CI: provided by the workflow (STAQPRO-134).
//
// If no DB is reachable, all DB-touching cases are skipped (not failed) so
// `npm test` still runs green for non-DB suites.

const DB_URL = process.env.TEST_POSTGRES_URL ?? process.env.POSTGRES_URL;

interface CheckRow {
  def: string;
}

async function getCheckValues(
  pool: Pool,
  table: string,
  constraintName: string,
): Promise<readonly string[]> {
  const { rows } = await pool.query<CheckRow>(
    `
    SELECT pg_get_constraintdef(c.oid) AS def
    FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'mailbox'
      AND t.relname = $1
      AND c.conname = $2
    `,
    [table, constraintName],
  );
  if (rows.length === 0) {
    throw new Error(`CHECK constraint not found: mailbox.${table} / ${constraintName}`);
  }
  // pg_get_constraintdef returns:
  //   CHECK ((status = ANY (ARRAY['pending'::text, 'awaiting_cloud'::text, ...])))
  const def = rows[0].def;
  const matches = [...def.matchAll(/'([^']+)'::text/g)];
  return matches.map((m) => m[1]);
}

async function getIndexDef(pool: Pool, indexName: string): Promise<string> {
  const { rows } = await pool.query<{ indexdef: string }>(
    `SELECT indexdef FROM pg_indexes WHERE schemaname = 'mailbox' AND indexname = $1`,
    [indexName],
  );
  if (rows.length === 0) {
    throw new Error(`index not found: mailbox.${indexName}`);
  }
  return rows[0].indexdef;
}

describe('mailbox schema invariants (drafts CHECK constraints ↔ TS constants)', () => {
  let pool: Pool | undefined;

  beforeAll(async () => {
    if (!DB_URL) {
      console.warn(
        '[schema-invariants] no TEST_POSTGRES_URL or POSTGRES_URL — skipping DB-backed cases.\n' +
          '  Tunnel: ssh -L 5432:localhost:5432 mailbox1 -N\n' +
          '  Run:    TEST_POSTGRES_URL=postgresql://mailbox:<pw>@localhost:5432/mailbox npm test',
      );
      return;
    }
    pool = new Pool({ connectionString: DB_URL, max: 2 });
  });

  afterAll(async () => {
    await pool?.end();
  });

  it.skipIf(!DB_URL)(
    "drafts.status CHECK matches the live state machine (pending → awaiting_cloud → approved/rejected/edited → sent; 'failed' retired by migration 016 / STAQPRO-202)",
    async () => {
      const allowed = await getCheckValues(pool!, 'drafts', 'drafts_status_check');
      const expected = ['pending', 'awaiting_cloud', 'approved', 'rejected', 'edited', 'sent'];
      expect([...allowed].sort()).toEqual([...expected].sort());
    },
  );

  it.skipIf(!DB_URL)(
    'drafts.draft_source CHECK accepts every route currently written by the live drafting path',
    async () => {
      const allowed = await getCheckValues(pool!, 'drafts', 'drafts_draft_source_check');
      // Live writes today: 'local' | 'cloud'. Constraint also keeps the legacy
      // 'local_qwen3' | 'cloud_haiku' values from migration 002→003 era for
      // backward compatibility. All four must be accepted; if a migration
      // narrows this set, this test catches it.
      for (const v of ['local', 'cloud', 'local_qwen3', 'cloud_haiku']) {
        expect(allowed).toContain(v);
      }
    },
  );

  it.skipIf(!DB_URL)(
    'drafts.classification_category CHECK matches CATEGORIES from lib/classification/prompt.ts',
    async () => {
      const allowed = await getCheckValues(pool!, 'drafts', 'drafts_classification_category_check');
      const expected = [...CATEGORIES];
      expect([...allowed].sort()).toEqual([...expected].sort());
    },
  );

  it.skipIf(!DB_URL)(
    'classification_log.category CHECK matches CATEGORIES — the MBOX-123 operator override appends a classification_log row, so its category set must equal the canonical CATEGORIES (migration 002)',
    async () => {
      const allowed = await getCheckValues(
        pool!,
        'classification_log',
        'classification_log_category_check',
      );
      const expected = [...CATEGORIES];
      expect([...allowed].sort()).toEqual([...expected].sort());
    },
  );

  it.skipIf(!DB_URL)(
    'kb_documents.status CHECK matches KB_DOC_STATUSES (STAQPRO-148, migration 014)',
    async () => {
      const allowed = await getCheckValues(pool!, 'kb_documents', 'kb_documents_status_check');
      const expected = [...KB_DOC_STATUSES];
      expect([...allowed].sort()).toEqual([...expected].sort());
    },
  );

  it.skipIf(!DB_URL)(
    'draft_feedback.reason_code CHECK matches REJECT_REASON_CODES (STAQPRO-331 #1, migration 023)',
    async () => {
      const allowed = await getCheckValues(
        pool!,
        'draft_feedback',
        'draft_feedback_reason_code_check',
      );
      const expected = [...REJECT_REASON_CODES];
      expect([...allowed].sort()).toEqual([...expected].sort());
    },
  );

  it.skipIf(!DB_URL)(
    'user_filter_preferences enforces single-row-per-key for the single-operator (operator_id IS NULL) world (MBOX-133, migration 026)',
    async () => {
      const def = await getIndexDef(pool!, 'user_filter_preferences_default_key_uidx');
      // Must be a UNIQUE partial index keyed on (key) and gated to the
      // NULL-operator default — that's what makes the single-operator case
      // one-row-per-key (a plain UNIQUE(operator_id,key) wouldn't, since NULLs
      // are distinct in Postgres).
      expect(def).toMatch(/CREATE UNIQUE INDEX/i);
      expect(def).toMatch(/\(key\)/);
      expect(def).toMatch(/WHERE \(operator_id IS NULL\)/i);
    },
  );

  it.skipIf(!DB_URL)(
    'chat_messages.role CHECK matches CHAT_MESSAGE_ROLES (MBOX-285, migration 027)',
    async () => {
      const allowed = await getCheckValues(pool!, 'chat_messages', 'chat_messages_role_check');
      const expected = [...CHAT_MESSAGE_ROLES];
      expect([...allowed].sort()).toEqual([...expected].sort());
    },
  );

  it.skipIf(!DB_URL)(
    'chat_messages has the (conversation_id, created_at) read index (MBOX-285, migration 027)',
    async () => {
      const def = await getIndexDef(pool!, 'chat_messages_conversation_id_created_at_idx');
      expect(def).toMatch(/CREATE INDEX/i);
      expect(def).toMatch(/\(conversation_id, created_at\)/);
    },
  );

  it.skipIf(!DB_URL)(
    'vip_senders.kind CHECK matches VIP_SENDER_KINDS (MBOX-134, migration 028)',
    async () => {
      const allowed = await getCheckValues(pool!, 'vip_senders', 'vip_senders_kind_check');
      const expected = [...VIP_SENDER_KINDS];
      expect([...allowed].sort()).toEqual([...expected].sort());
    },
  );

  it.skipIf(!DB_URL)(
    'prompt_rules.scope CHECK matches PROMPT_RULE_SCOPES (MBOX-162 P5b, migration 044)',
    async () => {
      const allowed = await getCheckValues(pool!, 'prompt_rules', 'prompt_rules_scope_check');
      const expected = [...PROMPT_RULE_SCOPES];
      expect([...allowed].sort()).toEqual([...expected].sort());
    },
  );

  it.skipIf(!DB_URL)(
    'vip_senders has the (email_or_domain, kind) unique index (MBOX-134, migration 028)',
    async () => {
      const def = await getIndexDef(pool!, 'vip_senders_value_kind_uidx');
      expect(def).toMatch(/CREATE UNIQUE INDEX/i);
      expect(def).toMatch(/\(email_or_domain, kind\)/);
    },
  );

  it.skipIf(!DB_URL)(
    'sender_never_spam has the unique (email) index — allowlist upsert key + classify-time lookup (MBOX-370, migrations 041→043)',
    async () => {
      const def = await getIndexDef(pool!, 'sender_never_spam_email_uidx');
      expect(def).toMatch(/CREATE UNIQUE INDEX/i);
      expect(def).toMatch(/\(email\)/);
    },
  );

  it.skipIf(!DB_URL)(
    'sender_never_spam carries NO category column — it is an allowlist, not a force-to-category rule (migration 043 dropped it)',
    async () => {
      const { rows } = await pool!.query<{ column_name: string }>(
        `SELECT column_name FROM information_schema.columns
          WHERE table_schema = 'mailbox' AND table_name = 'sender_never_spam'`,
      );
      const cols = rows.map((r) => r.column_name);
      expect(cols).toContain('email');
      expect(cols).not.toContain('category');
    },
  );

  it.skipIf(!DB_URL)(
    'auto_send_rules.action CHECK matches AUTO_SEND_ACTIONS (MBOX-16, migration 031)',
    async () => {
      const allowed = await getCheckValues(
        pool!,
        'auto_send_rules',
        'auto_send_rules_action_check',
      );
      const expected = [...AUTO_SEND_ACTIONS];
      expect([...allowed].sort()).toEqual([...expected].sort());
    },
  );

  it.skipIf(!DB_URL)(
    'auto_send_audit.effective_action CHECK matches AUTO_SEND_ACTIONS (MBOX-16, migration 031)',
    async () => {
      const allowed = await getCheckValues(
        pool!,
        'auto_send_audit',
        'auto_send_audit_effective_action_check',
      );
      const expected = [...AUTO_SEND_ACTIONS];
      expect([...allowed].sort()).toEqual([...expected].sort());
    },
  );

  it.skipIf(!DB_URL)(
    'auto_send_rules has the enabled (priority, id) partial eval index (MBOX-16, migration 031)',
    async () => {
      const def = await getIndexDef(pool!, 'auto_send_rules_enabled_priority_idx');
      expect(def).toMatch(/CREATE INDEX/i);
      expect(def).toMatch(/\(priority, id\)/);
      expect(def).toMatch(/WHERE \(enabled/i);
    },
  );

  it.skipIf(!DB_URL)(
    'accounts.provider CHECK matches MAIL_PROVIDERS (MBOX-356, migration 037)',
    async () => {
      const allowed = await getCheckValues(pool!, 'accounts', 'accounts_provider_check');
      const expected = [...MAIL_PROVIDERS];
      expect([...allowed].sort()).toEqual([...expected].sort());
    },
  );

  it('AUTO_SEND_ACTIONS from lib/types.ts has no duplicates and is non-empty', () => {
    expect(AUTO_SEND_ACTIONS.length).toBeGreaterThan(0);
    expect(new Set(AUTO_SEND_ACTIONS).size).toBe(AUTO_SEND_ACTIONS.length);
  });

  it('MAIL_PROVIDERS from lib/types.ts has no duplicates and is non-empty', () => {
    expect(MAIL_PROVIDERS.length).toBeGreaterThan(0);
    expect(new Set(MAIL_PROVIDERS).size).toBe(MAIL_PROVIDERS.length);
  });

  it('VIP_SENDER_KINDS from lib/types.ts has no duplicates and is non-empty', () => {
    expect(VIP_SENDER_KINDS.length).toBeGreaterThan(0);
    expect(new Set(VIP_SENDER_KINDS).size).toBe(VIP_SENDER_KINDS.length);
  });

  it('CHAT_MESSAGE_ROLES from lib/types.ts has no duplicates and is non-empty', () => {
    expect(CHAT_MESSAGE_ROLES.length).toBeGreaterThan(0);
    expect(new Set(CHAT_MESSAGE_ROLES).size).toBe(CHAT_MESSAGE_ROLES.length);
  });

  it('PREFERENCE_KEY_RE accepts dotted lowercase keys and rejects junk', () => {
    expect(PREFERENCE_KEY_RE.test('queue.filters')).toBe(true);
    expect(PREFERENCE_KEY_RE.test('queue.sort')).toBe(true);
    expect(PREFERENCE_KEY_RE.test('queue')).toBe(true);
    expect(PREFERENCE_KEY_RE.test('Queue.Filters')).toBe(false);
    expect(PREFERENCE_KEY_RE.test('queue filters')).toBe(false);
    expect(PREFERENCE_KEY_RE.test('.queue')).toBe(false);
    expect(PREFERENCE_KEY_RE.test('queue.')).toBe(false);
  });

  it('KB_DOC_STATUSES from lib/types.ts has no duplicates and is non-empty', () => {
    expect(KB_DOC_STATUSES.length).toBeGreaterThan(0);
    expect(new Set(KB_DOC_STATUSES).size).toBe(KB_DOC_STATUSES.length);
  });

  it('REJECT_REASON_CODES from lib/types.ts has no duplicates and is non-empty', () => {
    expect(REJECT_REASON_CODES.length).toBeGreaterThan(0);
    expect(new Set(REJECT_REASON_CODES).size).toBe(REJECT_REASON_CODES.length);
  });

  // Pure code-level invariant — does not need DB.
  it('CATEGORIES from prompt.ts has no duplicates and is non-empty', () => {
    expect(CATEGORIES.length).toBeGreaterThan(0);
    expect(new Set(CATEGORIES).size).toBe(CATEGORIES.length);
  });

  // Pure code-level invariant — confidence floor is in (0, 1) range.
  it('LOCAL_CONFIDENCE_FLOOR is a sane probability', async () => {
    const { LOCAL_CONFIDENCE_FLOOR } = await import('../lib/classification/prompt');
    expect(LOCAL_CONFIDENCE_FLOOR).toBeGreaterThan(0);
    expect(LOCAL_CONFIDENCE_FLOOR).toBeLessThan(1);
  });
});
