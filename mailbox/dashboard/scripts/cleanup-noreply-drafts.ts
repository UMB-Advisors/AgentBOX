// STAQPRO-260 — one-shot cleanup for accumulated noreply drafts.
//
// Runs ONLY when MAILBOX_APPLIANCE_ID matches a hand-picked allowlist —
// guards against accidental execution on Heron (mailbox1).
//
// Usage:
//   npx tsx dashboard/scripts/cleanup-noreply-drafts.ts --dry-run
//   npx tsx dashboard/scripts/cleanup-noreply-drafts.ts --apply
//
// Marks pending drafts whose `inbox_messages.from_addr` matches the
// noreply patterns as `rejected`. The state-transition trigger (migration
// 009) writes an audit row with actor='system' and reason='noreply_cleanup'
// (set via session-local GUC, same pattern as transitionToApprovedAndSend).

import { sql } from 'kysely';
import { NOREPLY_PATTERNS } from '../lib/classification/preclass';
import { getKysely, getPool } from '../lib/db';

const ALLOWED_APPLIANCES = new Set(['mailbox2']);

interface PendingMatch {
  id: number;
  from_addr: string | null;
  subject: string | null;
  classification_category: string | null;
  draft_source: string | null;
  created_at: string | null;
}

function matchesNoreply(addr: string | null): boolean {
  if (!addr) return false;
  return NOREPLY_PATTERNS.some((re) => re.test(addr));
}

async function findCandidates(): Promise<PendingMatch[]> {
  const db = getKysely();
  const rows = await db
    .selectFrom('drafts')
    .innerJoin('inbox_messages', 'inbox_messages.id', 'drafts.inbox_message_id')
    .select([
      'drafts.id',
      'inbox_messages.from_addr',
      'inbox_messages.subject',
      'drafts.classification_category',
      'drafts.draft_source',
      sql<string>`drafts.created_at::text`.as('created_at'),
    ])
    .where('drafts.status', '=', 'pending')
    .execute();

  // Pattern matching happens in JS so the regex source-of-truth stays in
  // preclass.ts (single canonical list).
  return rows.filter((r) => matchesNoreply(r.from_addr));
}

async function rejectDraft(id: number): Promise<void> {
  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT set_config('mailbox.actor', 'system', true)");
    await client.query("SELECT set_config('mailbox.transition_reason', 'noreply_cleanup', true)");
    await client.query(
      "UPDATE mailbox.drafts SET status = 'rejected' WHERE id = $1 AND status = 'pending'",
      [id],
    );
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const apply = args.includes('--apply');
  const dryRun = !apply;

  const applianceId = process.env.MAILBOX_APPLIANCE_ID ?? '<unset>';
  if (!ALLOWED_APPLIANCES.has(applianceId)) {
    console.error(
      `[cleanup-noreply] refusing to run on appliance "${applianceId}". ` +
        `Set MAILBOX_APPLIANCE_ID=mailbox2 to enable. Allowed: ${[...ALLOWED_APPLIANCES].join(', ')}`,
    );
    process.exit(2);
  }

  console.log(`[cleanup-noreply] mode=${dryRun ? 'DRY-RUN' : 'APPLY'} appliance=${applianceId}`);
  console.log('[cleanup-noreply] patterns:');
  for (const re of NOREPLY_PATTERNS) console.log(`  ${re.source} (flags: ${re.flags})`);

  const candidates = await findCandidates();
  console.log(`[cleanup-noreply] found ${candidates.length} pending drafts matching noreply`);
  for (const c of candidates) {
    console.log(
      `  draft id=${c.id} from=${c.from_addr} cat=${c.classification_category} source=${c.draft_source} subj="${(c.subject ?? '').slice(0, 60)}"`,
    );
  }

  if (dryRun) {
    console.log('[cleanup-noreply] dry run — no changes. Re-run with --apply to reject.');
    await getPool().end();
    return;
  }

  let rejected = 0;
  let failed = 0;
  for (const c of candidates) {
    try {
      await rejectDraft(c.id);
      rejected++;
    } catch (err) {
      failed++;
      console.error(`[cleanup-noreply] failed to reject id=${c.id}:`, err);
    }
  }
  console.log(`[cleanup-noreply] done. rejected=${rejected} failed=${failed}`);
  await getPool().end();
}

main().catch((err) => {
  console.error('[cleanup-noreply] fatal:', err);
  process.exit(1);
});
