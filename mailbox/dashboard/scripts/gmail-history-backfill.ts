// dashboard/scripts/gmail-history-backfill.ts
//
// STAQPRO-193 — CLI entry point for the Gmail Sent backfill. Wraps the
// orchestrator in `lib/onboarding/gmail-history-backfill.ts` and chains
// the existing `rag-backfill.ts` flow when --embed is passed.
//
// Run from the dashboard container (the canonical onboarding step):
//
//   docker compose run --rm mailbox-dashboard \
//     npm run onboarding:backfill -- --days 180
//
// Or, with embedding chained afterwards:
//
//   docker compose run --rm mailbox-dashboard \
//     npm run onboarding:backfill -- --days 180 --embed
//
// Required env: POSTGRES_URL, MAILBOX_OPERATOR_EMAIL.
// Optional env: RAG_BACKFILL_MAX_MESSAGES (default 5000),
//               MAILBOX_FETCH_HISTORY_URL (default n8n internal docker DNS).

import { spawn } from 'node:child_process';
import process from 'node:process';
import { Kysely, PostgresDialect } from 'kysely';
import { Pool, types } from 'pg';
import type { DB } from '../lib/db/schema';
import { runGmailHistoryBackfill } from '../lib/onboarding/gmail-history-backfill';

// Mirror dashboard/lib/db.ts: keep timestamps as strings for type alignment.
types.setTypeParser(1184, (v: string) => v);
types.setTypeParser(1114, (v: string) => v);

interface CliArgs {
  days: number;
  embed: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  const out: CliArgs = { days: 180, embed: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--days') {
      const v = argv[i + 1];
      if (!v) throw new Error('--days requires a value');
      out.days = Number(v);
      if (!Number.isFinite(out.days) || out.days <= 0) {
        throw new Error('--days must be a positive number');
      }
      i += 1;
    } else if (a === '--embed') {
      out.embed = true;
    } else if (a === '--help' || a === '-h') {
      console.log('Usage: npm run onboarding:backfill -- --days N [--embed]');
      process.exit(0);
    }
  }
  return out;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const url = process.env.POSTGRES_URL;
  if (!url) throw new Error('POSTGRES_URL not set');
  const operatorEmail = process.env.MAILBOX_OPERATOR_EMAIL;
  if (!operatorEmail) {
    throw new Error(
      'MAILBOX_OPERATOR_EMAIL not set — required to identify outbound messages from self',
    );
  }
  const maxMessages = Number(process.env.RAG_BACKFILL_MAX_MESSAGES ?? 5000);
  const fetchHistoryUrl =
    process.env.MAILBOX_FETCH_HISTORY_URL ?? 'http://n8n:5678/webhook/mailbox-fetch-history';

  const pool = new Pool({ connectionString: url, max: 2 });
  const db = new Kysely<DB>({ dialect: new PostgresDialect({ pool }) });

  const startedAt = Date.now();
  console.log(
    `[gmail-history-backfill] start days=${args.days} max=${maxMessages} operator=${operatorEmail}`,
  );

  try {
    const counts = await runGmailHistoryBackfill(
      {
        days_lookback: args.days,
        max_messages: maxMessages,
        operator_email: operatorEmail,
        fetch_history_url: fetchHistoryUrl,
      },
      { db },
    );
    const elapsedMs = Date.now() - startedAt;
    console.log(`[gmail-history-backfill] done in ${elapsedMs}ms`);
    console.log(`[gmail-history-backfill] counts: ${JSON.stringify(counts)}`);

    if (args.embed) {
      console.log('[gmail-history-backfill] chaining rag-backfill (--embed)');
      await runRagBackfill();
    } else {
      console.log(
        '[gmail-history-backfill] skip rag-backfill (no --embed). Run separately with: npm run rag:backfill',
      );
    }
  } finally {
    await db.destroy();
  }
}

function runRagBackfill(): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn('npx', ['tsx', 'scripts/rag-backfill.ts'], {
      stdio: 'inherit',
      env: process.env,
    });
    child.on('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`rag-backfill exited with code ${code}`));
    });
    child.on('error', reject);
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
