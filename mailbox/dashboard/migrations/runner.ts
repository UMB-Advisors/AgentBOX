import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from 'pg';

const here = dirname(fileURLToPath(import.meta.url));

async function main() {
  const url = process.env.POSTGRES_URL;
  if (!url) throw new Error('POSTGRES_URL not set');

  const client = new Client({ connectionString: url });
  await client.connect();

  await client.query(`
    CREATE SCHEMA IF NOT EXISTS mailbox;
    CREATE TABLE IF NOT EXISTS mailbox.migrations (
      version    TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  const files = (await readdir(here)).filter((f) => f.endsWith('.sql')).sort();

  for (const f of files) {
    const version = f.replace(/\.sql$/, '');
    const { rows } = await client.query('SELECT 1 FROM mailbox.migrations WHERE version = $1', [
      version,
    ]);
    if (rows.length > 0) {
      console.log(`[skip] ${version} (already applied)`);
      continue;
    }
    const sql = await readFile(join(here, f), 'utf8');
    console.log(`[apply] ${version}`);
    await client.query('BEGIN');
    try {
      await client.query(sql);
      await client.query('INSERT INTO mailbox.migrations (version) VALUES ($1)', [version]);
      await client.query('COMMIT');
      console.log(`[ok]    ${version}`);
    } catch (err) {
      await client.query('ROLLBACK');
      console.error(`[fail]  ${version}`);
      throw err;
    }
  }

  await client.end();
  console.log('migrations complete');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
