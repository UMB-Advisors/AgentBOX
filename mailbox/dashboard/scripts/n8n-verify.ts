// dashboard/scripts/n8n-verify.ts
//
// Audit 2026-05-15 (Neo Architect R2 + Liotta condition #2).
//
// Deploy-time guardrail: asserts that all four MailBOX* n8n workflows are
// `active = true` in n8n's workflow_entity table.
//
// Failure mode this catches (STAQPRO-181, 2026-05-01): the n8n 1.123 → 2.14
// upgrade silently dropped sub-workflow activation. ExecuteWorkflow calls
// to an inactive sub-workflow throw "Workflow is not active and cannot be
// executed" — dark-classifying the inbox for ~12h before anyone noticed.
// The CLAUDE.md runbook one-liner is doctrinal; this script is automated
// and exits non-zero so OTA / install scripts can gate on it.
//
// Invocation:
//   docker compose --profile n8n-verify run --rm mailbox-n8n-verify
//
// Exit codes:
//   0 — all four MailBOX* workflows present and active
//   1 — one or more workflows missing or inactive
//   2 — connection / query error (treated as failure for the gate)

import { Pool } from 'pg';

const REQUIRED_WORKFLOW_NAMES = [
  'MailBOX',
  'MailBOX-Classify',
  'MailBOX-Draft',
  'MailBOX-Send',
] as const;

interface WorkflowRow {
  name: string;
  active: boolean;
}

async function fetchWorkflows(pool: Pool): Promise<WorkflowRow[]> {
  // workflow_entity is n8n's table, in the same Postgres instance as
  // mailbox.* but not in the mailbox schema. Use unquoted table name —
  // n8n creates it in the public schema by default.
  const res = await pool.query<WorkflowRow>(
    "SELECT name, active FROM workflow_entity WHERE name LIKE 'MailBOX%' ORDER BY name",
  );
  return res.rows;
}

async function main(): Promise<number> {
  const url = process.env.POSTGRES_URL;
  if (!url) {
    console.error('[n8n-verify] POSTGRES_URL is not set — cannot connect');
    return 2;
  }

  const pool = new Pool({ connectionString: url, max: 2 });
  let rows: WorkflowRow[];
  try {
    rows = await fetchWorkflows(pool);
  } catch (e) {
    console.error('[n8n-verify] query failed:', e instanceof Error ? e.message : String(e));
    await pool.end();
    return 2;
  }
  await pool.end();

  const byName = new Map(rows.map((r) => [r.name, r.active]));
  const missing: string[] = [];
  const inactive: string[] = [];
  for (const expected of REQUIRED_WORKFLOW_NAMES) {
    if (!byName.has(expected)) {
      missing.push(expected);
    } else if (!byName.get(expected)) {
      inactive.push(expected);
    }
  }

  console.log('[n8n-verify] workflow inventory:');
  for (const expected of REQUIRED_WORKFLOW_NAMES) {
    const state = byName.has(expected) ? (byName.get(expected) ? 'active' : 'INACTIVE') : 'MISSING';
    console.log(`  ${expected.padEnd(24)} ${state}`);
  }
  for (const extra of rows) {
    if (!REQUIRED_WORKFLOW_NAMES.includes(extra.name as (typeof REQUIRED_WORKFLOW_NAMES)[number])) {
      console.log(`  ${extra.name.padEnd(24)} ${extra.active ? 'active' : 'inactive'} (extra)`);
    }
  }

  if (missing.length === 0 && inactive.length === 0) {
    console.log('[n8n-verify] OK — all four MailBOX* workflows are active');
    return 0;
  }
  if (missing.length > 0) {
    console.error(`[n8n-verify] MISSING: ${missing.join(', ')}`);
  }
  if (inactive.length > 0) {
    console.error(`[n8n-verify] INACTIVE: ${inactive.join(', ')}`);
    console.error('[n8n-verify] Reactivate via n8n editor, OR:');
    console.error('  docker exec mailbox-n8n-1 n8n update:workflow --active=true --id=<id>');
    console.error('  docker compose restart n8n');
  }
  return 1;
}

main()
  .then((code) => process.exit(code))
  .catch((e: unknown) => {
    console.error('[n8n-verify] unhandled error:', e instanceof Error ? e.message : String(e));
    process.exit(2);
  });
