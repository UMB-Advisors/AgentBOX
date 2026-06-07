import { Kysely, PostgresDialect } from 'kysely';
import { Pool, types } from 'pg';
import type { DB } from '@/lib/db/schema';

// pg returns TIMESTAMPTZ/TIMESTAMP as Date; we want strings to match wire format + our types.
// Kept on Kysely path too — schema.ts maps timestamp/timestamptz/date to `string` to reflect
// this runtime behavior (see scripts/codegen-db.sh `--type-mapping`).
types.setTypeParser(1184, (val: string) => val);
types.setTypeParser(1114, (val: string) => val);

let pool: Pool | undefined;
let kysely: Kysely<DB> | undefined;

export function getPool(): Pool {
  if (!pool) {
    pool = new Pool({
      connectionString: process.env.POSTGRES_URL,
      max: 10,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 5000,
    });

    pool.on('error', (err) => {
      console.error('Postgres pool error:', err);
    });
  }
  return pool;
}

// Kysely client wraps the same pg.Pool — one connection budget, two query
// surfaces during the kysely sweep (STAQPRO-136). Once all queries*.ts +
// inline pool.query callers are migrated, getPool stays for the migration
// runner and ad-hoc raw SQL via sql.raw escape hatch.
export function getKysely(): Kysely<DB> {
  if (!kysely) {
    kysely = new Kysely<DB>({
      dialect: new PostgresDialect({ pool: getPool() }),
    });
  }
  return kysely;
}

// Body cleanup applied before drafts.draft_body is persisted.
//   - BL-21: some early models emitted literal `\n` instead of newlines.
//   - Qwen3 emits <think>...</think> blocks in /api/chat output unless
//     `/no_think` is in the prompt; strip closed blocks defensively, plus
//     trim a stray unclosed-<think> prefix (happens when num_predict caps
//     mid-thinking).
export function normalizeDraftBody(body: string | null | undefined): string {
  if (!body) return '';
  let out = body.replace(/\\n/g, '\n');
  out = out.replace(/<think>[\s\S]*?<\/think>\s*/gi, '');
  out = out.replace(/^<think>[\s\S]*$/i, '');
  return out.trim();
}
